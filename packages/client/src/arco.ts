// The ONLY place that knows Arco's CLI contract (v0.10: `deploy --json` NDJSON,
// `info --resources --json` document; v0.25: `tenants:restore --json` document). A contract change should touch just this file.
import { spawn } from 'node:child_process';

/** The project's Composer-installed Arco: the default for Laravel apps. */
export const ARCO_BIN = 'vendor/bin/arco';

/**
 * The Arco binary to run: `explicit` (the action's `arco-bin` input), else `env.ARCO_BIN`, else `vendor/bin/arco`.
 * A path with a slash resolves against the project directory; a bare name such as `arco` (a global
 * `composer global require multiapi/arco`, for apps without `vendor/`) resolves through the child's PATH.
 */
export function resolveArcoBin(explicit?: string | null, env: NodeJS.ProcessEnv = {}): string {
  const fromInput = explicit?.trim();
  if (fromInput) return fromInput;
  const fromEnv = env.ARCO_BIN?.trim();
  return fromEnv ? fromEnv : ARCO_BIN;
}

export type ArcoEvent = { schema: 1; type: string; [key: string]: unknown };

export interface ArcoResult extends ArcoEvent {
  type: 'result';
  outcome: 'deployed' | 'removed' | 'failed' | 'refused';
  revision?: string | null;
  url?: unknown;
  domains?: unknown;
  cold_start_ms?: unknown;
  cold_start_deferred?: unknown;
  rolled_back?: boolean;
  error?: { key?: string; message?: string; params?: unknown } | null;
}

export interface ColdStartDeferred {
  log_group: string;
  since_ms: number;
  stream_prefixes: string[];
}

function isColdStartDeferred(v: unknown): v is ColdStartDeferred {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const { log_group: g, since_ms: s, stream_prefixes: p } = v as Record<string, unknown>;
  return typeof g === 'string' && g !== '' && typeof s === 'number' && Number.isInteger(s) && s >= 0 && Array.isArray(p) && p.every((x) => typeof x === 'string');
}

/** What a remove leaves behind: a kept resource, or the execution role kept on purpose for Lambda VPC interfaces. */
export type RemoveNote =
  | { type: string; name: string }
  | { key: 'remove.role_kept_for_interfaces'; role: string; region: string; functions: string };

export interface FinishPayload {
  result: 'succeeded' | 'removed' | 'failed';
  revision: string | null;
  rolled_back: boolean;
  error_code: string | null;
  error_message: string | null;
  arco_version: string | null;
  inventory?: unknown;
  /** Deploy mode only, and only when Arco's result carried a well-formed value. Older Cloud ignores them. */
  url?: string | null;
  domains?: string[] | null;
  cold_start_ms?: number | null;
  /** Where Arco Cloud can read the cold start from, when Arco deferred it (ARCO_DEFER_COLD_START=1). */
  cold_start_deferred?: ColdStartDeferred | null;
  /** Remove mode only: the resources Arco kept and, when it applies, the role kept for the interfaces. */
  notes?: RemoveNote[];
  /** Remove and tenants_restore modes: the error's `params` (string and number values), e.g. `resources` of `remove.leftovers`. */
  error_params?: Record<string, string | number>;
  /** tenants_restore mode only: the `outcome` of `arco tenants:restore --json`, when Arco reported one. */
  restore_outcome?: string;
}

// --json never prompts: a dispatch from Cloud is already user-confirmed, so always pass --yes
// (otherwise a first deploy of an environment is `refused` with deploy.confirm_required).
export const deployArgs = (environment: string, extra: string[] = []): string[] => ['deploy', `--env=${environment}`, '--yes', '--json', ...extra];
// `--force` deletes the environment's customer (tenant) domains: only when Cloud's start answer asked for it.
export const removeArgs = (environment: string, force = false): string[] => [
  'remove',
  `--env=${environment}`,
  '--yes',
  '--json',
  '--no-wait-interfaces',
  ...(force ? ['--force'] : []),
];
export const tenantsRestoreArgs = (environment: string): string[] => ['tenants:restore', `--env=${environment}`, '--json'];
export const infoArgs = (environment: string): string[] => ['info', `--env=${environment}`, '--resources', '--json'];
export const versionArgs = (): string[] => ['--version'];

/** Returns the event when the line is an Arco NDJSON event, else null (plain log line). */
export function parseEventLine(line: string): ArcoEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = JSON.parse(trimmed);
    if (value && typeof value === 'object' && value.schema === 1 && typeof value.type === 'string') {
      return value as ArcoEvent;
    }
  } catch {
    // not JSON: treat as a plain log line
  }
  return null;
}

export const isResult = (event: ArcoEvent): event is ArcoResult => event.type === 'result';

/** Parses the `info --resources --json` document; null when invalid. */
export function parseInventory(stdout: string): unknown | null {
  try {
    const value = JSON.parse(stdout);
    // `info` adds an `error` key when AWS could not be read: that listing is not a trustworthy inventory.
    return value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as any).resources) && !(value as any).error
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Extracts the first semver-looking token, e.g. "Arco 0.10.0" -> "0.10.0". */
export function parseVersion(stdout: string): string | null {
  return stdout.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0] ?? null;
}

export function toFinishPayload(
  result: ArcoResult | null,
  exitCode: number,
  arcoVersion: string | null,
  inventory: unknown | null,
): FinishPayload {
  const succeeded = result !== null && result.outcome === 'deployed' && exitCode === 0;
  let errorCode: string | null = result?.error?.key ?? null;
  let errorMessage: string | null = result?.error?.message ?? null;
  if (!succeeded && errorCode === null) {
    errorCode = result ? `deploy.${result.outcome}` : 'arco.no_result';
    errorMessage = errorMessage ?? (result ? `Deploy ${result.outcome}` : `Arco exited with code ${exitCode} without a result document`);
  }
  const payload: FinishPayload = {
    result: succeeded ? 'succeeded' : 'failed',
    revision: result?.revision ?? null,
    // `refused` means Arco stopped before changing anything, so nothing can have been rolled back.
    rolled_back: result?.outcome === 'refused' ? false : (result?.rolled_back ?? false),
    error_code: errorCode,
    error_message: errorMessage,
    arco_version: arcoVersion,
  };
  if (result) {
    // Forward only well-formed values; anything malformed is dropped rather than sent.
    const { url, domains, cold_start_ms: coldStartMs } = result;
    if (url === null || typeof url === 'string') payload.url = url;
    if (domains === null || (Array.isArray(domains) && domains.every((d) => typeof d === 'string'))) payload.domains = domains as string[] | null;
    if (result.cold_start_deferred === null || isColdStartDeferred(result.cold_start_deferred)) {
      payload.cold_start_deferred = result.cold_start_deferred === null ? null : { log_group: result.cold_start_deferred.log_group, since_ms: result.cold_start_deferred.since_ms, stream_prefixes: result.cold_start_deferred.stream_prefixes };
    }
    if (coldStartMs === null || (typeof coldStartMs === 'number' && Number.isFinite(coldStartMs))) payload.cold_start_ms = coldStartMs;
  }
  if (inventory !== null) payload.inventory = inventory;
  return payload;
}

/** The `remove.resource_kept` and `remove.role_kept_for_interfaces` notes of an event, as finish notes; null for any other event. */
export function removeNoteOf(event: ArcoEvent): RemoveNote | null {
  if (event.type !== 'step' || event.status !== 'note') return null;
  const params = event.params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  const p = params as Record<string, unknown>;
  if (event.key === 'remove.resource_kept' && typeof p.type === 'string' && typeof p.name === 'string') return { type: p.type, name: p.name };
  if (event.key === 'remove.role_kept_for_interfaces' && typeof p.role === 'string' && typeof p.region === 'string' && typeof p.functions === 'string') {
    return { key: 'remove.role_kept_for_interfaces', role: p.role, region: p.region, functions: p.functions };
  }
  return null;
}

/** The finish payload of `arco remove`: removed only when Arco says so and exits 0. */
export function toRemovePayload(result: ArcoResult | null, exitCode: number, arcoVersion: string | null, notes: RemoveNote[]): FinishPayload {
  const removed = result !== null && result.outcome === 'removed' && exitCode === 0;
  let errorCode: string | null = result?.error?.key ?? null;
  let errorMessage: string | null = result?.error?.message ?? null;
  if (!removed && errorCode === null) {
    errorCode = result ? `remove.${result.outcome}` : 'arco.no_result';
    errorMessage = errorMessage ?? (result ? `Remove ${result.outcome}` : `Arco exited with code ${exitCode} without a result document`);
  }
  const payload: FinishPayload = { result: removed ? 'removed' : 'failed', revision: null, rolled_back: false, error_code: errorCode, error_message: errorMessage, arco_version: arcoVersion, notes };
  const params = removed ? null : scalarParams(result?.error?.params);
  if (params !== null) payload.error_params = params;
  return payload;
}

/** The string and finite number values of an error's `params`; null when there are none. */
function scalarParams(params: unknown): Record<string, string | number> | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  const kept = Object.entries(params).filter((e): e is [string, string | number] => typeof e[1] === 'string' || (typeof e[1] === 'number' && Number.isFinite(e[1])));
  return kept.length > 0 ? Object.fromEntries(kept) : null;
}

/** The outcomes of `arco tenants:restore` that succeed (exit code 0). */
export const RESTORE_SUCCESS_OUTCOMES: readonly string[] = ['restored', 'already_enabled', 'limit_kept', 'nothing_to_restore'];

/**
 * The document `arco tenants:restore --json` prints on stdout (one pretty-printed JSON object, schema 1), or null
 * when stdout holds none. Text before the document (a stray PHP notice) is skipped.
 */
export function parseRestoreDocument(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n');
  const start = lines.findIndex((l) => l.startsWith('{'));
  for (const candidate of [stdout, start > 0 ? lines.slice(start).join('\n') : null]) {
    if (candidate === null || candidate.trim() === '') continue;
    try {
      const value = JSON.parse(candidate);
      if (typeof value === 'object' && value !== null && !Array.isArray(value) && value.schema === 1) return value as Record<string, unknown>;
    } catch {
      // not the document
    }
  }
  return null;
}

/** The finish payload of `arco tenants:restore`: succeeded only for a success outcome with exit code 0. */
export function toRestorePayload(doc: Record<string, unknown> | null, exitCode: number, arcoVersion: string | null): FinishPayload {
  const outcome = typeof doc?.outcome === 'string' ? doc.outcome : null;
  const succeeded = outcome !== null && RESTORE_SUCCESS_OUTCOMES.includes(outcome) && exitCode === 0;
  const error = typeof doc?.error === 'object' && doc.error !== null && !Array.isArray(doc.error) ? (doc.error as Record<string, unknown>) : null;
  let errorCode: string | null = succeeded ? null : typeof error?.key === 'string' && error.key !== '' ? error.key : null;
  let errorMessage: string | null = succeeded ? null : typeof error?.message === 'string' ? error.message : null;
  if (!succeeded && errorCode === null) {
    if (doc === null) {
      errorCode = 'arco.no_result';
      errorMessage = errorMessage ?? `Arco exited with code ${exitCode} without a result document`;
    } else if (outcome !== null && !RESTORE_SUCCESS_OUTCOMES.includes(outcome) && /^[a-z_]{1,40}$/.test(outcome)) {
      errorCode = `tenants.restore_${outcome}`;
      errorMessage = errorMessage ?? `Tenant domains restore ${outcome}`;
    } else {
      errorCode = 'tenants.restore_failed';
      errorMessage = errorMessage ?? `arco tenants:restore exited with code ${exitCode} (outcome ${outcome ?? 'missing'})`;
    }
  }
  const payload: FinishPayload = { result: succeeded ? 'succeeded' : 'failed', revision: null, rolled_back: false, error_code: errorCode, error_message: errorMessage, arco_version: arcoVersion };
  // Cloud accepts up to 64 characters; anything else is not an outcome it knows.
  if (outcome !== null && /^[a-z_]{1,64}$/.test(outcome)) payload.restore_outcome = outcome;
  const params = succeeded ? null : scalarParams(error?.params);
  if (params !== null) payload.error_params = params;
  return payload;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
}

export interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Aborting stops the child: SIGTERM, then SIGKILL after `killGraceMs`. */
  signal?: AbortSignal;
  killGraceMs?: number;
  uid?: number;
  gid?: number;
  /**
   * When set, resolve this many ms after the process emits 'exit' even if its stdout/stderr are still open
   * (held by a background grandchild), then stop reading them. Unset: resolve on 'close'.
   */
  settleAfterExitMs?: number;
}

function lineSplitter(emit: (line: string) => void) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        emit(buffer.slice(0, i).replace(/\r$/, ''));
        buffer = buffer.slice(i + 1);
      }
    },
    end() {
      if (buffer !== '') emit(buffer.replace(/\r$/, ''));
      buffer = '';
    },
  };
}

/** Runs `file <args>` in cwd, delivering stdout/stderr line by line. Never rejects. */
export function runCommand(file: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    const out = lineSplitter((l) => options.onStdoutLine?.(l));
    const err = lineSplitter((l) => options.onStderrLine?.(l));
    let child;
    try {
      // Own process group so the whole tree (build hooks included) can be stopped.
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        ...(options.uid !== undefined ? { uid: options.uid } : {}),
        ...(options.gid !== undefined ? { gid: options.gid } : {}),
      });
    } catch (e) {
      options.onStderrLine?.(`Failed to start ${file}: ${(e as Error).message}`);
      resolve({ exitCode: 127, stdout });
      return;
    }
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };
    let killTimer: NodeJS.Timeout | null = null;
    let settleTimer: NodeJS.Timeout | null = null;
    let done = false;
    const stop = () => {
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), options.killGraceMs ?? 5000);
    };
    const finish = (exitCode: number) => {
      if (done) return;
      done = true;
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      options.signal?.removeEventListener('abort', stop);
      out.end();
      err.end();
      resolve({ exitCode, stdout });
    };
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      if (done) return;
      stdout += c;
      out.push(c);
    });
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      if (!done) err.push(c);
    });
    child.on('error', (e) => {
      if (done) return;
      options.onStderrLine?.(`Failed to run ${file}: ${e.message}`);
      finish(127);
    });
    if (options.settleAfterExitMs !== undefined) {
      child.on('exit', (code) => {
        settleTimer = setTimeout(() => {
          // A background grandchild still holds the pipes: stop reading them and report the exit code.
          child.stdout.destroy();
          child.stderr.destroy();
          finish(code ?? 1);
        }, options.settleAfterExitMs);
      });
    }
    child.on('close', (code) => finish(code ?? 1));
  });
}

/** Runs `<bin> <args>` in cwd (`bin` defaults to `vendor/bin/arco`). Never rejects. */
export const runArco = (args: string[], options: CommandOptions, bin: string = ARCO_BIN): Promise<CommandResult> =>
  runCommand(bin, args, options);
