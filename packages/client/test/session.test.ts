import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawn } from 'node:child_process';
import { CloudApi, buildFailure, deployAndFinish, startRun } from '../src/index.js';

const SECRET = 'SECRETKEY1234567890abcdef';
const BOUNDARY = 'arn:aws:iam::123:policy/boundary';

let calls: { path: string; body: any }[];
let project: string;

beforeEach(() => {
  calls = [];
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
      });
    }
    return new Response(null, { status: 204 });
  });
});

const session = () => startRun({ api: new CloudApi('https://cloud.test', 'bearer-token-abcdef', 'dep_1'), nonce: 'nonce-123456', token: 'bearer-token-abcdef', batcher: { sleep: async () => {} } });
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

describe('buildFailure', () => {
  it('builds the failed finish payload', () => {
    expect(buildFailure('build.timeout', 'x')).toEqual({
      result: 'failed', revision: null, rolled_back: false, error_code: 'build.timeout', error_message: 'x', arco_version: null,
    });
  });
});
