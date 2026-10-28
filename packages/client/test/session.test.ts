import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CloudApi, CloudApiError, buildFailure, deployAndFinish, finishWithRetry, startRun } from '../src/index.js';

const SECRET = 'SECRETKEY1234567890abcdef';
const BOUNDARY = 'arn:aws:iam::123:policy/boundary';

let calls: { path: string; body: any }[];
let project: string;
let startExtra: Record<string, unknown>;

beforeEach(() => {
  calls = [];
  startExtra = {};
  project = mkdtempSync(join(tmpdir(), 'arco-client-'));
  mkdirSync(join(project, 'vendor/bin'), { recursive: true });
  const fake = resolve(__dirname, 'fixtures/fake-arco.mjs');
  writeFileSync(join(project, 'vendor/bin/arco'), `#!/bin/sh\nexec node "${fake}" "$@"\n`);
  chmodSync(join(project, 'vendor/bin/arco'), 0o755);
  vi.mocked(spawn).mockClear();
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const path = new URL(url).pathname.split('/').pop()!;
    calls.push({ path, body: JSON.parse(init.body) });
    if (path === 'start') {
      return Response.json({
        credentials: { accessKeyId: 'AKIAEXAMPLE12345', secretAccessKey: SECRET, sessionToken: 'SESSIONTOKEN-xyz', expiration: '2026-10-21T13:00:00Z' },
        region: 'us-east-1', environment: 'production', mode: 'deploy', permissionsBoundary: BOUNDARY,
        ...startExtra,
      });
    }
    return new Response(null, { status: 204 });
  });
});

const session = (extraSecrets: string[] = []) =>
  startRun({ api: new CloudApi('https://cloud.test', 'bearer-token-abcdef', 'dep_1'), nonce: 'nonce-123456', token: 'bearer-token-abcdef', extraSecrets, batcher: { sleep: async () => {} } });
const dep = (mode: 'deploy' | 'inventory', env: NodeJS.ProcessEnv) => ({ mode, environment: 'production', cwd: project, env });

describe('startRun + deployAndFinish', () => {
  it('posts start, logs and finish in that order', async () => {
    const s = await session();
    const code = await deployAndFinish(s, dep('deploy', { ...process.env, FAKE_ARCO_CALLS: join(project, 'calls.txt') }));
    expect(code).toBe(0);
    const order = calls.map((c) => c.path);
    expect(order[0]).toBe('start');
    expect(order.at(-1)).toBe('finish');
    expect(order.slice(1, -1).length).toBeGreaterThan(0);
    expect(new Set(order.slice(1, -1))).toEqual(new Set(['logs']));
    expect(calls.at(-1)!.body).toMatchObject({ result: 'succeeded', revision: 'r42', arco_version: '0.10.0' });
  });

  it('passes AWS_* to every child and the permissions boundary to deploy only', async () => {
    const dump = join(project, 'env.json');
    const s = await session();
    await deployAndFinish(s, dep('deploy', { ...process.env, FAKE_ARCO_ENVDUMP: dump }));
    for (const cmd of ['deploy', 'info', '--version']) {
      const env = JSON.parse(readFileSync(`${dump}.${cmd}`, 'utf8'));
      expect(env).toMatchObject({ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE12345', AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: 'SESSIONTOKEN-xyz', AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' });
      if (cmd === 'deploy') expect(env.ARCO_PERMISSIONS_BOUNDARY).toBe(BOUNDARY);
      else expect(env).not.toHaveProperty('ARCO_PERMISSIONS_BOUNDARY');
    }
  });

  it('passes uid and gid to spawn', async () => {
    const s = await session();
    await deployAndFinish(s, { ...dep('inventory', { ...process.env }), uid: process.getuid!(), gid: process.getgid!() });
    const spawned = vi.mocked(spawn).mock.calls;
    expect(spawned.length).toBeGreaterThan(0);
    for (const [, , options] of spawned) expect(options).toMatchObject({ uid: process.getuid!(), gid: process.getgid!() });
  });
});

describe('external DNS', () => {
  const DNS = {
    profile: 'arco-cloud-dns',
    credentials: { accessKeyId: 'ASIADNSKEY98765', secretAccessKey: 'dnsSecretValue/987', sessionToken: 'dnsSessionToken-987', expiration: '2026-10-28T13:00:00Z' },
  };
  const CF = 'cf-token-abcdef123';
  beforeEach(() => {
    startExtra = { dns: DNS, cloudflareToken: CF };
  });
  const argv = (file: string, cmd: string) => readFileSafe(file).split('\n').find((l) => l.split(' ')[0] === cmd) ?? '';

  it('exposes dns and cloudflareToken on the session', async () => {
    const s = await session();
    expect(s.dns).toEqual(DNS);
    expect(s.cloudflareToken).toBe(CF);
  });

  it('defaults to null when Cloud sends neither', async () => {
    startExtra = {};
    const s = await session();
    expect(s.dns).toBeNull();
    expect(s.cloudflareToken).toBeNull();
  });

  it('gives the profile file, flag and token to the deploy child only, and removes the file afterwards', async () => {
    const dump = join(project, 'env.json');
    const callsFile = join(project, 'calls.txt');
    const s = await session();
    const code = await deployAndFinish(s, dep('deploy', { ...process.env, FAKE_ARCO_ENVDUMP: dump, FAKE_ARCO_CALLS: callsFile }));
    expect(code).toBe(0);

    const deployEnv = JSON.parse(readFileSync(`${dump}.deploy`, 'utf8'));
    expect(deployEnv.CLOUDFLARE_API_TOKEN).toBe(CF);
    expect(deployEnv.AWS_SHARED_CREDENTIALS_FILE).toMatch(/credentials$/);
    expect(argv(callsFile, 'deploy')).toBe('deploy --env=production --yes --json --dns-profile=arco-cloud-dns');
    for (const cmd of ['info', '--version']) {
      const env = JSON.parse(readFileSync(`${dump}.${cmd}`, 'utf8'));
      expect(env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
      expect(env).not.toHaveProperty('AWS_SHARED_CREDENTIALS_FILE');
      expect(argv(callsFile, cmd)).not.toContain('--dns-profile');
    }
    expect(existsSync(deployEnv.AWS_SHARED_CREDENTIALS_FILE)).toBe(false);
  });

  it('removes the file when arco exits non-zero', async () => {
    const dump = join(project, 'env.json');
    const s = await session();
    const code = await deployAndFinish(s, dep('deploy', { ...process.env, FAKE_ARCO_ENVDUMP: dump, FAKE_ARCO_SCENARIO: 'crash' }));
    expect(code).toBe(2);
    const file = JSON.parse(readFileSync(`${dump}.deploy`, 'utf8')).AWS_SHARED_CREDENTIALS_FILE;
    expect(file).toBeTruthy();
    expect(existsSync(file)).toBe(false);
  });

  it('removes the file when the run is aborted', async () => {
    const dump = join(project, 'env.json');
    const callsFile = join(project, 'calls.txt');
    const s = await session();
    const done = deployAndFinish(s, { ...dep('deploy', { ...process.env, FAKE_ARCO_ENVDUMP: dump, FAKE_ARCO_CALLS: callsFile, FAKE_ARCO_SCENARIO: 'hang' }), killGraceMs: 50 });
    for (let i = 0; i < 200 && !readFileSafe(callsFile).includes('pid'); i++) await new Promise((r) => setTimeout(r, 25));
    const file = JSON.parse(readFileSync(`${dump}.deploy`, 'utf8')).AWS_SHARED_CREDENTIALS_FILE;
    expect(existsSync(file)).toBe(true);
    revoke(s);
    await expect(done).rejects.toThrow(/ended this run/);
    expect(existsSync(file)).toBe(false);
  }, 10000);

  it('redacts the token and the three DNS values from logs and secrets', async () => {
    const s = await session();
    for (const v of [CF, DNS.credentials.accessKeyId, DNS.credentials.secretAccessKey, DNS.credentials.sessionToken]) expect(s.secrets).toContain(v);
    await deployAndFinish(s, dep('deploy', { ...process.env, FAKE_ARCO_LEAK_DNS: '1' }));
    const lines = calls.filter((c) => c.path === 'logs').flatMap((c) => c.body.lines).join('\n');
    expect(lines).toContain('[arco-cloud-dns]'); // the child could read the file
    expect(lines).toContain('cloudflare=***');
    for (const v of [CF, DNS.credentials.accessKeyId, DNS.credentials.secretAccessKey, DNS.credentials.sessionToken]) expect(lines).not.toContain(v);
  });

  it('fails the start on a malformed answer', async () => {
    startExtra = { cloudflareToken: 12 };
    await expect(session()).rejects.toThrow(/start answer was malformed/);
  });
});

describe('redaction of structured payloads', () => {
  const literals = ['true', '2525', 'failed', 'succeeded', 'null'];

  it('a secret equal to a JSON literal, digits of a number or a result value does not break a successful run', async () => {
    const s = await session(literals);
    const code = await deployAndFinish(
      s,
      dep('deploy', { ...process.env, FAKE_ARCO_RESULT: JSON.stringify({ cold_start_ms: 12525, url: 'https://true.example/failed' }) }),
    );
    expect(code).toBe(0);
    const finish = calls.at(-1)!;
    expect(finish.path).toBe('finish');
    expect(finish.body).toMatchObject({ result: 'succeeded', rolled_back: false, cold_start_ms: 12525, url: 'https://***.example/***' });
    const events = calls.filter((c) => c.path === 'logs').flatMap((c) => c.body.events);
    expect(events.find((e: any) => e.type === 'result')).toMatchObject({ cold_start_ms: 12525, rolled_back: false });
  });

  it('a secret equal to "failed" keeps a failed result failed and masks it inside messages', async () => {
    const s = await session(literals);
    const code = await deployAndFinish(s, dep('deploy', { ...process.env, FAKE_ARCO_SCENARIO: 'failed' }));
    expect(code).toBe(1);
    expect(calls.at(-1)!.body).toMatchObject({ result: 'failed', rolled_back: true, error_message: 'Health check ***' });
  });
});

describe('CloudApi timeout', () => {
  it('aborts a request the server never answers, as a retryable (non-HTTP) error', async () => {
    vi.unstubAllGlobals();
    const server = createServer(() => {}); // never answers
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const api = new CloudApi(`http://127.0.0.1:${port}`, 'tok', 'dep_1', { timeoutMs: 100 });
      const error = await api.logs({ seq: 1, lines: [], events: [] }).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(CloudApiError);
      expect(error.message).toMatch(/logs timed out after 100 ms/);

      const warnings: string[] = [];
      const sleeps: number[] = [];
      await finishWithRetry(api, { result: 'failed' }, async (ms) => void sleeps.push(ms), (m) => warnings.push(m));
      expect(sleeps).toHaveLength(3); // retried like a network error
      expect(warnings[0]).toMatch(/timed out/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('defaults to a 30 s timeout per request', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      seen.push(init.signal);
      return new Response(null, { status: 204 });
    });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await new CloudApi('https://cloud.test', 'tok', 'dep_1').logs({ seq: 1, lines: [], events: [] });
    expect(timeout).toHaveBeenCalledWith(30000);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });
});

describe('arco --version', () => {
  it('is stopped when Cloud revokes the run', async () => {
    const s = await session();
    const callsFile = join(project, 'calls.txt');
    const done = deployAndFinish(s, { ...dep('inventory', { ...process.env, FAKE_ARCO_CALLS: callsFile, FAKE_ARCO_VERSION: 'hang' }), killGraceMs: 50 });
    // Wait for --version to start, then revoke.
    for (let i = 0; i < 200 && !(readFileSafe(callsFile).includes('--version')); i++) await new Promise((r) => setTimeout(r, 25));
    expect(readFileSafe(callsFile)).toContain('--version');
    revoke(s);
    await expect(done).rejects.toThrow(/ended this run/);
  }, 10000);
});

/** Makes Cloud answer the next log batch with 409 lease_lost, which aborts the session. */
function revoke(s: Awaited<ReturnType<typeof session>>): void {
  vi.stubGlobal('fetch', async () => Response.json({ error: 'lease_lost' }, { status: 409 }));
  s.batcher.addLine('x');
  void s.batcher.flush();
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

describe('buildFailure', () => {
  it('builds the failed finish payload', () => {
    expect(buildFailure('build.timeout', 'x')).toEqual({
      result: 'failed', revision: null, rolled_back: false, error_code: 'build.timeout', error_message: 'x', arco_version: null,
    });
  });
});

describe('finishWithRetry when Cloud refuses the report', () => {
  function cloud(statuses: number[]) {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      const status = statuses.shift() ?? 204;
      return new Response(status === 204 ? null : JSON.stringify({ message: 'invalid' }), { status });
    });
    return { api: new CloudApi('https://cloud.test', 'tok', 'dep_1'), bodies };
  }

  const succeeded = {
    result: 'succeeded', revision: 'rev-1', rolled_back: false, error_code: null, error_message: null, arco_version: '0.11.4',
    url: 'https://x.lambda-web.us-east-1.on.aws', domains: ['shop.example.com'], cold_start_ms: 900, inventory: { resources: [] },
  };

  it('sends the result again once without the optional fields, without sleeping', async () => {
    const { api, bodies } = cloud([422, 204]);
    const warnings: string[] = [];
    const sleeps: number[] = [];

    await finishWithRetry(api, succeeded, async (ms) => void sleeps.push(ms), (m) => warnings.push(m));

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ result: 'succeeded', revision: 'rev-1', rolled_back: false, error_code: null, error_message: null, arco_version: '0.11.4' });
    expect(sleeps).toEqual([]);
    expect(warnings[0]).toMatch(/without url, domains, cold start and inventory/);
  });

  it('reports an explicit failure when the stripped result is refused too', async () => {
    const { api, bodies } = cloud([422, 422, 204]);
    const warnings: string[] = [];

    await finishWithRetry(api, succeeded, async () => {}, (m) => warnings.push(m));

    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toMatchObject({ result: 'failed', error_code: 'cloud.finish_rejected' });
    expect(bodies[2].error_message).toMatch(/refused the deploy result/);
    expect(warnings[1]).toMatch(/reporting the deployment as failed/);
  });

  it('goes straight to the failure report when there were no optional fields, and stops if that is refused', async () => {
    const { api, bodies } = cloud([400, 400]);
    const warnings: string[] = [];

    await finishWithRetry(api, { result: 'failed', revision: null, rolled_back: false, error_code: 'x', error_message: 'y', arco_version: null }, async () => {}, (m) => warnings.push(m));

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ error_code: 'cloud.finish_rejected' });
    expect(warnings.at(-1)).toMatch(/refused the failure report too/);
  });

  it('still retries 429 and 5xx with backoff', async () => {
    const { api, bodies } = cloud([429, 503, 204]);
    const sleeps: number[] = [];

    await finishWithRetry(api, succeeded, async (ms) => void sleeps.push(ms));

    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toEqual(succeeded);
    expect(sleeps).toEqual([500, 1000]);
  });
});
