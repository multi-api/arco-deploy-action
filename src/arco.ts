// The ONLY place that knows Arco's CLI contract (v0.10: `deploy --json` NDJSON,
// `info --resources --json` document). A contract change should touch just this file.
import { spawn } from 'node:child_process';

export const ARCO_BIN = 'vendor/bin/arco';

export type ArcoEvent = { schema: 1; type: string; [key: string]: unknown };

export interface ArcoResult extends ArcoEvent {
  type: 'result';
  outcome: 'deployed' | 'removed' | 'failed' | 'refused';
  revision?: string | null;
  url?: unknown;
  domains?: unknown;
  cold_start_ms?: unknown;
  rolled_back?: boolean;
  error?: { key?: string; message?: string } | null;
}

export interface FinishPayload {
  result: 'succeeded' | 'failed';
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
}

// --json never prompts: a dispatch from Cloud is already user-confirmed, so always pass --yes
// (otherwise a first deploy of an environment is `refused` with deploy.confirm_required).
export const deployArgs = (environment: string): string[] => ['deploy', `--env=${environment}`, '--yes', '--json'];
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
    if (coldStartMs === null || (typeof coldStartMs === 'number' && Number.isFinite(coldStartMs))) payload.cold_start_ms = coldStartMs;
  }
  if (inventory !== null) payload.inventory = inventory;
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

/** Runs `vendor/bin/arco <args>` in cwd, delivering stdout/stderr line by line. Never rejects. */
export function runArco(args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    const out = lineSplitter((l) => options.onStdoutLine?.(l));
    const err = lineSplitter((l) => options.onStderrLine?.(l));
    let child;
    try {
      // Own process group so the whole tree (build hooks included) can be stopped.
      child = spawn(ARCO_BIN, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      options.onStderrLine?.(`Failed to start ${ARCO_BIN}: ${(e as Error).message}`);
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
    const stop = () => {
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), options.killGraceMs ?? 5000);
    };
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      stdout += c;
      out.push(c);
    });
    child.stderr.setEncoding('utf8').on('data', (c: string) => err.push(c));
    child.on('error', (e) => {
      if (killTimer) clearTimeout(killTimer);
      options.onStderrLine?.(`Failed to run ${ARCO_BIN}: ${e.message}`);
      resolve({ exitCode: 127, stdout });
    });
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', stop);
      out.end();
      err.end();
      resolve({ exitCode: code ?? 1, stdout });
    });
  });
}
