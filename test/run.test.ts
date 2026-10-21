import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { run, type RunOptions } from '../src/run';

const SECRET = 'SECRETKEY1234567890abcdef';
const SESSION = 'SESSIONTOKEN-xyz-987654';
const ACCESS = 'AKIAEXAMPLE12345';

interface Call { path: string; headers: Record<string, string>; body: any }
let calls: Call[];
let project: string;
let callsFile: string;
let logsFailures: number;

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
    expect(argv).toContain('deploy --env=production --json');
    expect(argv).toContain('info --env=production --resources --json');
  });

  it('streams NDJSON as events and other output as lines, never leaking credentials', async () => {
    await run(opts());
    const lines = logCalls().flatMap((c) => c.body.lines);
    const events = logCalls().flatMap((c) => c.body.events);
    expect(lines).toContain('plain line before events');
    expect(lines).toContain('stderr line');
    expect(events.map((e: any) => e.type)).toEqual(['step', 'progress', 'result']);
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

  it('does not export credentials into the action process environment', async () => {
    await run(opts());
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('rejects when start fails and never runs arco', async () => {
    vi.stubGlobal('fetch', async () => new Response('no', { status: 403 }));
    await expect(run(opts())).rejects.toThrow('HTTP 403');
    expect(existsSync(callsFile)).toBe(false);
  });
});
