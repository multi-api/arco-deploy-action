import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { run, RunAbortedError, type RunOptions } from '../src/run';

const SECRET = 'SECRETKEY1234567890abcdef';
const SESSION = 'SESSIONTOKEN-xyz-987654';
const ACCESS = 'AKIAEXAMPLE12345';

interface Call { path: string; headers: Record<string, string>; body: any }
let calls: Call[];
let project: string;
let callsFile: string;
let logsFailures: number;
let logsAnswer: { status: number; body: unknown } | null;

function setupProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arco-proj-'));
  mkdirSync(join(dir, 'vendor/bin'), { recursive: true });
  const fake = resolve(__dirname, 'fixtures/fake-arco.mjs');
  writeFileSync(join(dir, 'vendor/bin/arco'), `#!/bin/sh\nexec node "${fake}" "$@"\n`);
  chmodSync(join(dir, 'vendor/bin/arco'), 0o755);
  return dir;
}

beforeEach(() => {
  calls = [];
  logsFailures = 0;
  logsAnswer = null;
  project = setupProject();
  callsFile = join(project, 'calls.txt');
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const path = new URL(url).pathname.split('/').pop()!;
    const call = { path, headers: init.headers, body: JSON.parse(init.body) };
    if (path === 'logs' && logsFailures > 0) {
      logsFailures--;
      return new Response('boom', { status: 500 });
    }
    calls.push(call);
    if (path === 'logs' && logsAnswer) return Response.json(logsAnswer.body, { status: logsAnswer.status });
    if (path === 'start') {
      return Response.json({
        credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET, sessionToken: SESSION, expiration: '2026-10-21T13:00:00Z' },
        region: 'us-east-1', environment: 'production', mode: 'deploy',
      });
    }
    return new Response(null, { status: 204 });
  });
});

const opts = (extra: Partial<RunOptions> & { fake?: Record<string, string> } = {}): RunOptions => {
  const { fake, ...rest } = extra;
  return {
    token: 'bearer-token-abcdef', apiUrl: 'https://cloud.test', environment: 'production', deploymentId: 'dep_1',
    nonce: 'nonce-123456', mode: 'deploy', workingDirectory: project,
    env: { ...process.env, FAKE_ARCO_CALLS: callsFile, ...fake },
    batcher: { sleep: async () => {} },
    ...rest,
  };
};
const logCalls = () => calls.filter((c) => c.path === 'logs');
const finish = () => calls.find((c) => c.path === 'finish')!.body;

describe('run', () => {
  it('start sends nonce with the contract headers; success finishes as succeeded with inventory and version', async () => {
    const code = await run(opts());
    expect(code).toBe(0);
    const start = calls[0];
    expect(start.path).toBe('start');
    expect(start.body).toEqual({ nonce: 'nonce-123456' });
    expect(start.headers).toMatchObject({ Authorization: 'Bearer bearer-token-abcdef', 'X-Arco-Cloud-Api': '1', Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(finish()).toMatchObject({ result: 'succeeded', revision: 'r42', rolled_back: false, error_code: null, error_message: null, arco_version: '0.10.0' });
    expect(finish().inventory.resources[0].name).toBe('jobs');
    const argv = readFileSync(callsFile, 'utf8').trim().split('\n');
    expect(argv).toContain('deploy --env=production --yes --json');
    expect(argv).toContain('info --env=production --resources --json');
  });

  it('streams NDJSON as events and other output as lines, never leaking credentials', async () => {
    await run(opts());
    const lines = logCalls().flatMap((c) => c.body.lines);
    const events = logCalls().flatMap((c) => c.body.events);
    expect(lines).toContain('plain line before events');
    expect(lines).toContain('stderr line');
    expect(events.map((e: any) => e.type)).toEqual(['step', 'progress', 'result'])
    expect(events[1].key).toBe('binary.download');
    const everything = JSON.stringify(calls.filter((c) => c.path !== 'start').map((c) => c.body));
    for (const s of [SECRET, SESSION, ACCESS, 'bearer-token-abcdef']) expect(everything).not.toContain(s);
    expect(lines.some((l: string) => l.includes('AWS_SECRET_ACCESS_KEY=***'))).toBe(true);
  });

  it('seq increases across batches and a retried batch reuses its seq', async () => {
    logsFailures = 2; // first batch fails twice, succeeds on 3rd attempt
    await run(opts({ batcher: { maxItems: 2, sleep: async () => {} } }));
    const seqs = logCalls().map((c) => c.body.seq);
    expect(seqs.length).toBeGreaterThan(1);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // no gaps: failed attempts consumed no new seq
    expect(finish().result).toBe('succeeded');
  });

  it('gives up on a batch after 3 retries without failing the deploy', async () => {
    logsFailures = 4;
    const warn = vi.fn();
    const code = await run(opts({ warn, batcher: { maxItems: 2, sleep: async () => {} } }));
    expect(code).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Dropping log batch 1'));
    expect(logCalls()[0].body.seq).toBe(2);
  });

  it('a failing deploy still posts inventory and finish with result failed, mirroring the exit code', async () => {
    const code = await run(opts({ fake: { FAKE_ARCO_SCENARIO: 'failed' } }));
    expect(code).toBe(1);
    expect(finish()).toMatchObject({ result: 'failed', revision: 'r41', rolled_back: true, error_code: 'deploy.health_check_failed', error_message: 'Health check failed' });
    expect(finish().inventory.resources).toHaveLength(1);
  });

  it('maps refused to failed with the error key and rolled_back false', async () => {
    const code = await run(opts({ fake: { FAKE_ARCO_SCENARIO: 'refused' } }));
    expect(code).toBe(1);
    expect(finish()).toMatchObject({ result: 'failed', error_code: 'deploy.confirm_required', error_message: 'Confirmation needed', rolled_back: false });
  });

  it('an option error (exit 1, no result line) finishes failed with arco.no_result', async () => {
    const code = await run(opts({ fake: { FAKE_ARCO_SCENARIO: 'opterror' } }));
    expect(code).toBe(1);
    expect(finish()).toMatchObject({ result: 'failed', error_code: 'arco.no_result', rolled_back: false });
    expect(logCalls().flatMap((c) => c.body.lines)).toContain('The "--bogus" option does not exist.');
  });

  it('a crash without a result document finishes failed with a synthetic error', async () => {
    const code = await run(opts({ fake: { FAKE_ARCO_SCENARIO: 'crash' } }));
    expect(code).toBe(2);
    expect(finish()).toMatchObject({ result: 'failed', revision: null, error_code: 'arco.no_result' });
  });

  it('omits inventory when info prints invalid JSON or fails', async () => {
    await run(opts({ fake: { FAKE_ARCO_INFO: 'bad' } }));
    expect(finish()).not.toHaveProperty('inventory');
    calls = [];
    await run(opts({ fake: { FAKE_ARCO_INFO: 'fail' } }));
    expect(finish()).not.toHaveProperty('inventory');
  });

  it('mode=inventory never runs deploy', async () => {
    const code = await run(opts({ mode: 'inventory' }));
    expect(code).toBe(0);
    const argv = readFileSync(callsFile, 'utf8');
    expect(argv).not.toContain('deploy');
    expect(argv).toContain('info --env=production --resources --json');
    expect(finish()).toMatchObject({ result: 'succeeded', revision: null });
    expect(finish().inventory).toBeDefined();
  });

  it('mode=inventory without an inventory finishes failed and exits non-zero', async () => {
    for (const info of ['bad', 'fail']) {
      calls = [];
      const code = await run(opts({ mode: 'inventory', fake: { FAKE_ARCO_INFO: info } }));
      expect(code).toBe(1);
      expect(finish()).toMatchObject({ result: 'failed', error_code: 'arco.inventory_failed' });
      expect(finish()).not.toHaveProperty('inventory');
    }
  });

  it('redacts secrets in the finish payload (error message)', async () => {
    const code = await run(opts({ fake: { FAKE_ARCO_SCENARIO: 'leakyfail' } }));
    expect(code).toBe(1);
    const body = JSON.stringify(calls.find((c) => c.path === 'finish')!.body);
    expect(body).not.toContain(SECRET);
    expect(finish().error_message).toContain('***');
  });

  it('does not export credentials into the action process environment', async () => {
    await run(opts());
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('rejects when start fails and never runs arco', async () => {
    vi.stubGlobal('fetch', async () => new Response('no', { status: 403 }));
    await expect(run(opts())).rejects.toThrow('HTTP 403');
    expect(existsSync(callsFile)).toBe(false);
  });

  it('strips INPUT_* and the Cloud token from the child environment but keeps AWS and the rest', async () => {
    const dump = join(project, 'env.json');
    await run(opts({
      fake: {
        FAKE_ARCO_ENVDUMP: dump, INPUT_TOKEN: 'bearer-token-abcdef', INPUT_NONCE: 'nonce-123456', 'INPUT_API-URL': 'https://cloud.test',
        INPUT_ENVIRONMENT: 'production', ARCO_TOKEN: 'x-arco-token', COPIED_TOKEN: 'bearer-token-abcdef', KEEP_ME: 'yes',
      },
    }));
    const env = JSON.parse(readFileSync(dump, 'utf8'));
    expect(Object.keys(env).filter((k) => k.toUpperCase().startsWith('INPUT_'))).toEqual([]);
    expect(env).not.toHaveProperty('ARCO_TOKEN');
    expect(env).not.toHaveProperty('COPIED_TOKEN');
    expect(env).toMatchObject({ KEEP_ME: 'yes', AWS_ACCESS_KEY_ID: ACCESS, AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: SESSION, AWS_REGION: 'us-east-1' });
  });

  const pidOf = () => Number(readFileSync(callsFile, 'utf8').match(/^pid (\d+)$/m)![1]);
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  it.each([
    [409, 'lease_lost'],
    [409, 'finished'],
    [403, 'not_runner'],
  ])('HTTP %i %s on logs stops arco, skips finish and aborts the action', async (status, error) => {
    logsAnswer = { status, body: { error } };
    const err = await run(opts({ fake: { FAKE_ARCO_SCENARIO: 'hang' }, batcher: { maxItems: 1, sleep: async () => {} } })).catch((e) => e);
    expect(err).toBeInstanceOf(RunAbortedError);
    expect(err.message).toContain(`HTTP ${status}`);
    expect(err.message).toContain('stopped Arco');
    expect(alive(pidOf())).toBe(false);
    expect(calls.some((c) => c.path === 'finish')).toBe(false);
    expect(logCalls()).toHaveLength(1); // no retries, no further batches
    expect(readFileSync(callsFile, 'utf8')).not.toContain('info --env'); // nothing runs after the abort
  });

  it('SIGKILLs an arco that ignores SIGTERM after the grace period', async () => {
    logsAnswer = { status: 409, body: { error: 'lease_lost' } };
    const err = await run(opts({ killGraceMs: 200, fake: { FAKE_ARCO_SCENARIO: 'stubborn' }, batcher: { maxItems: 1, sleep: async () => {} } })).catch((e) => e);
    expect(err).toBeInstanceOf(RunAbortedError);
    expect(alive(pidOf())).toBe(false);
    expect(calls.some((c) => c.path === 'finish')).toBe(false);
  });

  it('other failures (HTTP 409 with another error, 500) are still retried and do not stop arco', async () => {
    logsAnswer = { status: 409, body: { error: 'duplicate_seq' } };
    const warn = vi.fn();
    const code = await run(opts({ warn, batcher: { maxItems: 2, sleep: async () => {} } }));
    expect(code).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Dropping log batch'));
    expect(calls.some((c) => c.path === 'finish')).toBe(true);
  });
});
