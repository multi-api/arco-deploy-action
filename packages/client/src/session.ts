import { CloudApi, CloudApiError, isRunLost, type Credentials, type StartResponse } from './api.js';
import { Redactor, redactValue } from './redactor.js';
import { Batcher, type BatcherOptions } from './batcher.js';
import { parseExternalDns, withExternalDns, type ExternalDns } from './dns.js';
import { CONFIG_LAYER_MIN_ARCO, parseConfigLayer, supportsConfigLayer, withConfigLayer } from './layer.js';
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
} from './arco.js';

/** Cloud revoked this run (lease lost, finished, or not the runner): arco was stopped and nothing more is reported. */
export class RunAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunAbortedError';
  }
}

/** A finish payload for a run that failed before (or without) producing an Arco result. */
export function buildFailure(code: string, message: string): FinishPayload {
  return { result: 'failed', revision: null, rolled_back: false, error_code: code, error_message: message, arco_version: null };
}

/** Cloud refused the request itself (validation and the like): sending it again cannot help. */
function isRefused(e: unknown): e is CloudApiError {
  return e instanceof CloudApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429 && !isRunLost(e);
}

/** The optional fields a Cloud may refuse; the result itself never depends on them. */
const OPTIONAL_FIELDS = ['url', 'domains', 'cold_start_ms', 'inventory'] as const;

/**
 * Reports the result, retrying network errors and 5xx. A refused report (4xx) is not sent again
 * as is: first once without its optional fields, then as an explicit failure, so the deployment
 * never stays open waiting for a result Cloud will not accept.
 */
export async function finishWithRetry(
  api: CloudApi,
  payload: unknown,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  warn: (m: string) => void = () => {},
): Promise<void> {
  let current = payload;
  let fallback: 'stripped' | 'failure' | null = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await api.finish(current);
      return;
    } catch (e) {
      if (isRunLost(e)) {
        warn(`Arco Cloud rejected the result: ${e.message}`);
        return;
      }
      if (isRefused(e)) {
        const record = typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {};
        if (fallback === null && OPTIONAL_FIELDS.some((f) => f in record)) {
          warn(`Arco Cloud refused the result (${e.message}); sending it again without url, domains, cold start and inventory`);
          current = Object.fromEntries(Object.entries(record).filter(([k]) => !(OPTIONAL_FIELDS as readonly string[]).includes(k)));
          fallback = 'stripped';
          attempt = -1;
          continue;
        }
        if (fallback !== 'failure') {
          warn(`Arco Cloud refused the result (${e.message}); reporting the deployment as failed`);
          current = buildFailure('cloud.finish_rejected', `Arco Cloud refused the deploy result: ${e.message}`);
          fallback = 'failure';
          attempt = -1;
          continue;
        }
        warn(`Arco Cloud refused the failure report too: ${e.message}`);
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

export interface StartRunOptions {
  api: CloudApi;
  nonce: string;
  /** The Cloud API token: only used to redact it from outbound text. */
  token: string;
  /** Extra redaction applied after the built-in secret redaction. */
  redact?: (text: string) => string;
  extraSecrets?: string[];
  /** Shared redactor; the token, nonce and credentials are added to it. A new one is created when omitted. */
  redactor?: Redactor;
  warn?: (message: string) => void;
  batcher?: Partial<BatcherOptions>;
}

export interface RunSession {
  api: CloudApi;
  started: StartResponse;
  /** Route 53 credentials for the deploy child (`--dns-profile`); null when Cloud sent none. */
  dns: ExternalDns | null;
  /** CLOUDFLARE_API_TOKEN for the deploy child; null when Cloud sent none. */
  cloudflareToken: string | null;
  /** Every value that must never leave the machine: AWS and DNS credentials, Cloudflare token, Cloud token, nonce and extras. */
  secrets: string[];
  redact: (text: string) => string;
  batcher: Batcher;
  /** Aborted when Cloud ends the run. */
  signal: AbortSignal;
  abortMessage(): string | null;
  /** The AWS_* variables for the child process. */
  awsEnv: Record<string, string>;
  warn: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** The fields of the start answer the run cannot go on without; anything of the wrong shape throws. */
function parseStartAnswer(started: unknown) {
  const { dns, cloudflareToken } = parseExternalDns(started);
  const { credentials, region } = started as Record<string, unknown>;
  const malformed = (field: string) => new Error(`Arco Cloud start answer was malformed (${field})`);
  if (credentials === null || typeof credentials !== 'object' || Array.isArray(credentials)) throw malformed('credentials');
  const c = credentials as Record<string, unknown>;
  for (const key of ['accessKeyId', 'secretAccessKey', 'sessionToken']) {
    if (typeof c[key] !== 'string' || c[key] === '') throw malformed(`credentials.${key}`);
  }
  if (typeof region !== 'string' || region === '') throw malformed('region');
  parseConfigLayer(started);
  return { credentials: credentials as Credentials, region, dns, cloudflareToken };
}

/** Calls start, derives the secrets and redaction, and wires a log batcher that aborts the run when Cloud revokes it. */
export async function startRun(o: StartRunOptions): Promise<RunSession> {
  const warn = o.warn ?? (() => {});
  const started = await o.api.start(o.nonce);
  let parsed: ReturnType<typeof parseStartAnswer>;
  try {
    parsed = parseStartAnswer(started);
  } catch (e) {
    // Nothing ran yet: report the failure now rather than leave the run open until Cloud sweeps it as heartbeat_lost.
    // The message names fields only, never values, so it carries no secret.
    const message = e instanceof Error ? e.message : String(e);
    await finishWithRetry(o.api, buildFailure('cloud.start_answer_invalid', message), o.batcher?.sleep, warn);
    throw e;
  }
  const { credentials, region, dns, cloudflareToken } = parsed;

  const redactor = o.redactor ?? new Redactor();
  const dnsSecrets = dns ? [dns.credentials.accessKeyId, dns.credentials.secretAccessKey, dns.credentials.sessionToken] : [];
  for (const secret of [
    credentials.accessKeyId,
    credentials.secretAccessKey,
    credentials.sessionToken,
    ...dnsSecrets,
    ...(cloudflareToken !== null ? [cloudflareToken] : []),
    o.token,
    o.nonce,
    ...(o.extraSecrets ?? []),
  ]) {
    redactor.add(secret);
  }
  const redactSecrets = (text: string) => redactor.redact(text);
  const redact = o.redact ? (text: string) => o.redact!(redactSecrets(text)) : redactSecrets;

  const controller = new AbortController();
  let abortMessage: string | null = null;
  const batcher = new Batcher({
    isFatal: isRunLost,
    onAbort: (e) => {
      abortMessage = `Arco Cloud ended this run (${(e as Error).message}); stopped Arco and did not report a result.`;
      controller.abort();
    },
    send: (p) => o.api.logs(p),
    redact,
    onError: warn,
    ...o.batcher,
  });

  return {
    api: o.api,
    started,
    dns,
    cloudflareToken,
    secrets: [...redactor.secrets],
    redact,
    batcher,
    signal: controller.signal,
    abortMessage: () => abortMessage,
    awsEnv: {
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_SESSION_TOKEN: credentials.sessionToken,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
    },
    warn,
    sleep: o.batcher?.sleep,
  };
}

export interface DeployOptions {
  mode: 'deploy' | 'inventory';
  environment: string;
  cwd: string;
  /** Base environment of the child; the AWS_* variables are added on top. */
  env: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
  /** Grace between SIGTERM and SIGKILL when Cloud revokes the run. Default 5000. */
  killGraceMs?: number;
  /** Where the DNS credentials file's temporary directory is created. Default: the OS temporary directory. */
  dnsDir?: string;
  /** Where the config layer file's temporary directory is created. Default: the OS temporary directory. */
  layerDir?: string;
}

/**
 * With a config layer: version check -> layer file. Then deploy -> info -> version -> finish. Returns the process
 * exit code to mirror (0 = success).
 */
export async function deployAndFinish(s: RunSession, o: DeployOptions): Promise<number> {
  const awsEnv: NodeJS.ProcessEnv = { ...o.env, ...s.awsEnv };
  const common = { cwd: o.cwd, uid: o.uid, gid: o.gid };
  const throwIfAborted = () => {
    const message = s.abortMessage();
    if (message !== null) throw new RunAbortedError(message);
  };
  const failEarly = async (code: string, message: string, arcoVersion: string | null = null) => {
    s.batcher.addLine(message);
    await s.batcher.flush();
    await finishWithRetry(s.api, { ...buildFailure(code, message), arco_version: arcoVersion }, s.sleep, s.warn);
    return 1;
  };

  const layer = s.started.config ?? null;
  let arcoVersion: string | null = null;
  if (layer !== null) {
    // An Arco older than the layer ignores ARCO_CONFIG_LAYER and would deploy without the managed resources.
    const version = await runArco(versionArgs(), { ...common, env: awsEnv, signal: s.signal, killGraceMs: o.killGraceMs });
    if (version.exitCode === 0) arcoVersion = parseVersion(version.stdout);
    throwIfAborted();
    if (!supportsConfigLayer(arcoVersion)) {
      return failEarly(
        'config.arco_outdated',
        `This environment has Arco Cloud resources, which need multiapi/arco ${CONFIG_LAYER_MIN_ARCO} or later; ` +
          `the project has ${arcoVersion === null ? 'an unknown version' : arcoVersion}. Run composer require multiapi/arco:^0.13.`,
        arcoVersion,
      );
    }
  }

  // Every arco child reads the layer (Arco reads it in deploy and info); the file is removed however the run ends.
  let layerChild: Awaited<ReturnType<typeof withConfigLayer>>;
  try {
    layerChild = await withConfigLayer(awsEnv, layer, o.layerDir, { uid: o.uid, gid: o.gid });
  } catch (e) {
    return failEarly('config.layer_file_failed', s.redact(`Could not write the config layer file: ${e instanceof Error ? e.message : String(e)}`), arcoVersion);
  }
  try {
    return await runAndFinish(s, o, layerChild.env, arcoVersion);
  } finally {
    await layerChild.cleanup();
  }
}

async function runAndFinish(s: RunSession, o: DeployOptions, childEnv: NodeJS.ProcessEnv, knownVersion: string | null): Promise<number> {
  // Only deploys get the boundary (not inventory, info or --version), and only when Cloud sent a non-empty string.
  const boundary = s.started.permissionsBoundary;
  const deployEnv: NodeJS.ProcessEnv =
    o.mode === 'deploy' && typeof boundary === 'string' && boundary !== '' ? { ...childEnv, ARCO_PERMISSIONS_BOUNDARY: boundary } : childEnv;
  const common = { cwd: o.cwd, uid: o.uid, gid: o.gid };
  const throwIfAborted = () => {
    const message = s.abortMessage();
    if (message !== null) throw new RunAbortedError(message);
  };

  let exitCode = 0;
  let result: ArcoResult | null = null;

  if (o.mode === 'deploy') {
    // Only the deploy child gets the DNS profile file, --dns-profile and CLOUDFLARE_API_TOKEN; the file is removed
    // however arco ends (success, non-zero exit, or stopped because Cloud revoked the run).
    let dns: Awaited<ReturnType<typeof withExternalDns>>;
    try {
      dns = await withExternalDns(deployEnv, [], s, o.dnsDir, { uid: o.uid, gid: o.gid });
    } catch (e) {
      // Nothing ran yet: report the failure now rather than leave the run open until Cloud sweeps it.
      const message = s.redact(`Could not write the DNS credentials file: ${e instanceof Error ? e.message : String(e)}`);
      s.batcher.addLine(message);
      await s.batcher.flush();
      await finishWithRetry(s.api, buildFailure('dns.credentials_file_failed', message), s.sleep, s.warn);
      return 1;
    }
    try {
      const deploy = await runArco(deployArgs(o.environment, dns.args), {
        ...common,
        env: dns.env,
        signal: s.signal,
        killGraceMs: o.killGraceMs,
        onStdoutLine: (line) => {
          const event = parseEventLine(line);
          if (event) {
            s.batcher.addEvent(event);
            if (isResult(event)) result = event;
          } else {
            s.batcher.addLine(line);
          }
        },
        onStderrLine: (line) => s.batcher.addLine(line),
      });
      exitCode = deploy.exitCode;
    } finally {
      await dns.cleanup();
    }
  }
  // The final batch can still be in flight when arco exits: wait for it so a revoked run is noticed before info/finish.
  await s.batcher.flush();
  throwIfAborted();

  const info = await runArco(infoArgs(o.environment), {
    ...common,
    env: childEnv,
    signal: s.signal,
    killGraceMs: o.killGraceMs,
    onStderrLine: (line) => s.batcher.addLine(line),
  });
  const inventory = info.exitCode === 0 ? parseInventory(info.stdout) : null;
  if (inventory === null) s.batcher.addLine('Could not collect the resource inventory.');

  let arcoVersion = knownVersion;
  if (arcoVersion === null) {
    const version = await runArco(versionArgs(), { ...common, env: childEnv, signal: s.signal, killGraceMs: o.killGraceMs });
    if (version.exitCode === 0) arcoVersion = parseVersion(version.stdout);
  }

  await s.batcher.flush();
  throwIfAborted();

  const rawPayload: FinishPayload =
    o.mode === 'deploy'
      ? toFinishPayload(result, exitCode, arcoVersion, inventory)
      : inventory !== null
        ? { result: 'succeeded', revision: null, rolled_back: false, error_code: null, error_message: null, arco_version: arcoVersion, inventory }
        : // inventory mode exists only to obtain the inventory: without it the request failed
          { result: 'failed', revision: null, rolled_back: false, error_code: 'arco.inventory_failed', error_message: 'Could not collect the resource inventory', arco_version: arcoVersion };
  // Arco's messages and inventory are untrusted text: redact like every other outbound string. `result` is our own
  // enum, never secret material, so it is kept even when a secret happens to equal "failed" or "succeeded".
  const payload: FinishPayload = { ...redactValue(rawPayload, s.redact), result: rawPayload.result };

  await finishWithRetry(s.api, payload, s.sleep, s.warn);

  if (payload.result === 'succeeded') return 0;
  return o.mode === 'deploy' ? exitCode || 1 : 1;
}
