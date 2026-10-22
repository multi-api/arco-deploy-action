import { CloudApi, RunAbortedError, deployAndFinish, startRun } from '@multiapi/arco-cloud-client';

export interface RunOptions {
  token: string;
  apiUrl: string;
  environment: string;
  deploymentId: string;
  nonce: string;
  mode: string;
  workingDirectory: string;
  env?: NodeJS.ProcessEnv;
  mask?: (secret: string) => void;
  warn?: (message: string) => void;
  /** Grace between SIGTERM and SIGKILL when Cloud revokes the run. Default 5000. */
  killGraceMs?: number;
  batcher?: { intervalMs?: number; maxItems?: number; sleep?: (ms: number) => Promise<void> };
}

export { RunAbortedError };

/** Variables the child (and so the customer's build hooks) must never see: action inputs and the Cloud API token. A stale ARCO_PERMISSIONS_BOUNDARY is dropped too: only Cloud's start response may set it. */
export function childBaseEnv(env: NodeJS.ProcessEnv, secrets: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('INPUT_') || upper === 'ARCO_TOKEN' || upper === 'ARCO_PERMISSIONS_BOUNDARY') continue;
    if (value !== undefined && secrets.includes(value)) continue;
    out[key] = value;
  }
  return out;
}

/** Returns the process exit code the action should mirror (0 = success). */
export async function run(opts: RunOptions): Promise<number> {
  const session = await startRun({
    api: new CloudApi(opts.apiUrl, opts.token, opts.deploymentId),
    nonce: opts.nonce,
    token: opts.token,
    warn: opts.warn,
    batcher: opts.batcher,
  });
  session.secrets.forEach((s) => opts.mask?.(s));

  return deployAndFinish(session, {
    mode: opts.mode as 'deploy' | 'inventory',
    environment: opts.environment,
    cwd: opts.workingDirectory,
    // Credentials live only in the child environment; process.env is never modified.
    env: childBaseEnv(opts.env ?? process.env, [opts.token, opts.nonce].filter((v) => v.length >= 4)),
    killGraceMs: opts.killGraceMs,
  });
}
