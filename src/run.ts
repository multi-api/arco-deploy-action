import { CloudApi } from './api';
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
  batcher?: { intervalMs?: number; maxItems?: number; sleep?: (ms: number) => Promise<void> };
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
    ...(opts.env ?? process.env),
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_SESSION_TOKEN: credentials.sessionToken,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  };

  const batcher = new Batcher({
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
      env: childEnv,
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

  const info = await runArco(infoArgs(opts.environment), {
    cwd: opts.workingDirectory,
    env: childEnv,
    onStderrLine: (line) => batcher.addLine(line),
  });
  const inventory = info.exitCode === 0 ? parseInventory(info.stdout) : null;
  if (inventory === null) batcher.addLine('Could not collect the resource inventory.');

  let arcoVersion: string | null = null;
  const version = await runArco(versionArgs(), { cwd: opts.workingDirectory, env: childEnv });
  if (version.exitCode === 0) arcoVersion = parseVersion(version.stdout);

  await batcher.flush();

  const payload =
    opts.mode === 'deploy'
      ? toFinishPayload(result, exitCode, arcoVersion, inventory)
      : // inventory mode: nothing was deployed, so the request itself succeeded
        { result: 'succeeded' as const, revision: null, rolled_back: false, error_code: null, error_message: null, arco_version: arcoVersion, ...(inventory !== null ? { inventory } : {}) };

  await finishWithRetry(api, payload, opts.batcher?.sleep, warn);

  return opts.mode === 'deploy' && payload.result === 'failed' ? exitCode || 1 : 0;
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
      if (attempt === 3) {
        warn(`Could not report the result to Arco Cloud: ${(e as Error).message}`);
        return;
      }
      await sleep(500 * 2 ** attempt);
    }
  }
}
