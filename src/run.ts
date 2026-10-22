import { CloudApi, isRunLost } from './api';
import { Batcher } from './batcher';
import {
  deployArgs,
  infoArgs,
  isResult,
  parseEventLine,
  parseInventory,
  parseVersion,
  runArco,
  toFinishPayload,
  versionArgs,
  type ArcoResult,
  type FinishPayload,
} from './arco';

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

/** Cloud revoked this run (lease lost, finished, or not the runner): arco was stopped and nothing more is reported. */
export class RunAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunAbortedError';
  }
}

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
  const warn = opts.warn ?? (() => {});
  const api = new CloudApi(opts.apiUrl, opts.token, opts.deploymentId);
  const started = await api.start(opts.nonce);
  const { credentials, region } = started;

  const secrets = [credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken, opts.token, opts.nonce].filter(
    (s) => typeof s === 'string' && s.length >= 4,
  );
  secrets.forEach((s) => opts.mask?.(s));
  const redact = (text: string) => secrets.reduce((t, s) => t.split(s).join('***'), text);

  // Credentials live only in the child environment; process.env is never modified.
  const childEnv: NodeJS.ProcessEnv = {
    ...childBaseEnv(opts.env ?? process.env, [opts.token, opts.nonce].filter((v) => v.length >= 4)),
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_SESSION_TOKEN: credentials.sessionToken,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  };

  // Only deploys get the boundary (not inventory, info or --version), and only when Cloud sent a non-empty string.
  const boundary = started.permissionsBoundary;
  const deployEnv: NodeJS.ProcessEnv =
    opts.mode === 'deploy' && typeof boundary === 'string' && boundary !== ''
      ? { ...childEnv, ARCO_PERMISSIONS_BOUNDARY: boundary }
      : childEnv;

  const controller = new AbortController();
  let abortMessage: string | null = null;
  const batcher = new Batcher({
    isFatal: isRunLost,
    onAbort: (e) => {
      abortMessage = `Arco Cloud ended this run (${(e as Error).message}); stopped Arco and did not report a result.`;
      controller.abort();
    },
    send: (p) => api.logs(p),
    redact,
    onError: warn,
    ...opts.batcher,
  });

  let exitCode = 0;
  let result: ArcoResult | null = null;

  if (opts.mode === 'deploy') {
    const deploy = await runArco(deployArgs(opts.environment), {
      cwd: opts.workingDirectory,
      env: deployEnv,
      signal: controller.signal,
      killGraceMs: opts.killGraceMs,
      onStdoutLine: (line) => {
        const event = parseEventLine(line);
        if (event) {
          batcher.addEvent(event);
          if (isResult(event)) result = event;
        } else {
          batcher.addLine(line);
        }
      },
      onStderrLine: (line) => batcher.addLine(line),
    });
    exitCode = deploy.exitCode;
  }
  // The final batch can still be in flight when arco exits: wait for it so a revoked run is noticed before info/finish.
  await batcher.flush();
  if (abortMessage !== null) throw new RunAbortedError(abortMessage);

  const info = await runArco(infoArgs(opts.environment), {
    cwd: opts.workingDirectory,
    env: childEnv,
    signal: controller.signal,
    killGraceMs: opts.killGraceMs,
    onStderrLine: (line) => batcher.addLine(line),
  });
  const inventory = info.exitCode === 0 ? parseInventory(info.stdout) : null;
  if (inventory === null) batcher.addLine('Could not collect the resource inventory.');

  let arcoVersion: string | null = null;
  const version = await runArco(versionArgs(), { cwd: opts.workingDirectory, env: childEnv });
  if (version.exitCode === 0) arcoVersion = parseVersion(version.stdout);

  await batcher.flush();
  if (abortMessage !== null) throw new RunAbortedError(abortMessage);

  const rawPayload: FinishPayload =
    opts.mode === 'deploy'
      ? toFinishPayload(result, exitCode, arcoVersion, inventory)
      : inventory !== null
        ? { result: 'succeeded', revision: null, rolled_back: false, error_code: null, error_message: null, arco_version: arcoVersion, inventory }
        : // inventory mode exists only to obtain the inventory: without it the request failed
          { result: 'failed', revision: null, rolled_back: false, error_code: 'arco.inventory_failed', error_message: 'Could not collect the resource inventory', arco_version: arcoVersion };
  // Arco's messages and inventory are untrusted text: redact like every other outbound string.
  const payload = JSON.parse(redact(JSON.stringify(rawPayload))) as FinishPayload;

  await finishWithRetry(api, payload, opts.batcher?.sleep, warn);

  if (payload.result === 'succeeded') return 0;
  return opts.mode === 'deploy' ? exitCode || 1 : 1;
}

async function finishWithRetry(
  api: CloudApi,
  payload: unknown,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  warn: (m: string) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await api.finish(payload);
      return;
    } catch (e) {
      if (isRunLost(e)) {
        warn(`Arco Cloud rejected the result: ${e.message}`);
        return;
      }
      if (attempt === 3) {
        warn(`Could not report the result to Arco Cloud: ${(e as Error).message}`);
        return;
      }
      await sleep(500 * 2 ** attempt);
    }
  }
}
