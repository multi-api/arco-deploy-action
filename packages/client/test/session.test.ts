import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { ARCO_BIN, CloudApi, CloudApiError, buildFailure, deployAndFinish, finishWithRetry, resolveArcoBin, startRun } from '../src/index.js';
import { sha256, tarball } from './helpers/tarball.js';

const SECRET = 'SECRETKEY1234567890abcdef';
const BOUNDARY = 'arn:aws:iam::123:policy/boundary';

let calls: { path: string; body: any }[];
let project: string;
let startExtra: Record<string, unknown>;
/** Bodies served for https://ext.test/<name> downloads. */
let downloads: Record<string, Buffer>;

beforeEach(() => {
  calls = [];
  startExtra = {};
  downloads = {};
  project = mkdtempSync(join(tmpdir(), 'arco-client-'));
  mkdirSync(join(project, 'vendor/bin'), { recursive: true });
  const fake = resolve(__dirname, 'fixtures/fake-arco.mjs');
  writeFileSync(join(project, 'vendor/bin/arco'), `#!/bin/sh\nexec node "${fake}" "$@"\n`);
  chmodSync(join(project, 'vendor/bin/arco'), 0o755);
  vi.mocked(spawn).mockClear();
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    if (new URL(url).host === 'ext.test') {
      const body = downloads[new URL(url).pathname.slice(1)];
      return body ? new Response(body) : new Response(null, { status: 404 });
    }
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

  it('finishes the run as dns.credentials_file_failed when the file cannot be written, without running arco', async () => {
    const callsFile = join(project, 'calls.txt');
    const s = await session();
    const code = await deployAndFinish(s, {
      ...dep('deploy', { ...process.env, FAKE_ARCO_CALLS: callsFile }),
      dnsDir: join(project, 'does-not-exist'),
    });
    expect(code).toBe(1);
    expect(existsSync(callsFile)).toBe(false);
    const finish = calls.at(-1)!;
    expect(finish.path).toBe('finish');
    expect(finish.body).toMatchObject({ result: 'failed', error_code: 'dns.credentials_file_failed', rolled_back: false, revision: null });
    expect(finish.body.error_message).toMatch(/^Could not write the DNS credentials file: ENOENT/);
    const lines = calls.filter((c) => c.path === 'logs').flatMap((c) => c.body.lines).join('\n');
    expect(lines).toContain('Could not write the DNS credentials file');
  });

  it('redacts secrets from the dns.credentials_file_failed message', async () => {
    const s = await session();
    const code = await deployAndFinish(s, { ...dep('deploy', { ...process.env }), dnsDir: join(project, CF) });
    expect(code).toBe(1);
    const finish = calls.at(-1)!;
    expect(finish.body.error_code).toBe('dns.credentials_file_failed');
    expect(finish.body.error_message).not.toContain(CF);
    expect(finish.body.error_message).toContain('***');
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

  it.each([
    ['cloudflareToken', { cloudflareToken: 12 }],
    ['dns', { dns: { profile: 'arco-cloud-dns' } }],
    ['credentials', { credentials: 'nope' }],
    ['credentials.secretAccessKey', { credentials: { accessKeyId: 'AKIAEXAMPLE12345', sessionToken: 'SESSIONTOKEN-xyz' } }],
    ['region', { region: 7 }],
  ])('reports cloud.start_answer_invalid and fails the start on a malformed %s', async (field, extra) => {
    startExtra = extra;
    await expect(session()).rejects.toThrow(/start answer was malformed/);
    const finish = calls.at(-1)!;
    expect(finish.path).toBe('finish');
    expect(finish.body).toMatchObject({ result: 'failed', error_code: 'cloud.start_answer_invalid', rolled_back: false, revision: null });
    expect(finish.body.error_message).toContain(`(${field}`);
    expect(JSON.stringify(finish.body)).not.toContain(SECRET);
  });
});

describe('config layer', () => {
  const LAYER = { schema: 1, app: 'shop', environments: { production: { queues: { emails: { timeout: 60 } }, variables: { MAIL_FROM_ADDRESS: 'hi@shop.test' } } } };
  beforeEach(() => {
    startExtra = { config: LAYER };
  });
  const layerLines = (file: string) => readFileSafe(file).split('\n').filter((l) => l.startsWith('layer '));
  const run = async (extra: NodeJS.ProcessEnv = {}, opts: Record<string, unknown> = {}) => {
    const callsFile = join(project, 'calls.txt');
    const dump = join(project, 'env.json');
    const s = await session();
    const code = await deployAndFinish(s, {
      ...dep('deploy', { ...process.env, FAKE_ARCO_VERSION: '0.13.0', FAKE_ARCO_CALLS: callsFile, FAKE_ARCO_ENVDUMP: dump, ...extra }),
      ...opts,
    });
    return { code, callsFile, dump, finish: calls.at(-1)! };
  };

  it('refuses a start answer whose config is not an object', async () => {
    for (const config of ['{}', [], 42, true]) {
      calls = [];
      startExtra = { config };
      await expect(session()).rejects.toThrow('Arco Cloud start answer was malformed (config)');
      expect(calls.at(-1)).toMatchObject({ path: 'finish', body: { result: 'failed', error_code: 'cloud.start_answer_invalid' } });
    }
  });

  it('writes the layer to a 0600 file for deploy and info, and removes it afterwards', async () => {
    const { code, callsFile, dump, finish } = await run();
    expect(code).toBe(0);
    // The version check runs before the file exists.
    expect(layerLines(callsFile)).toEqual([`layer deploy 600 ${JSON.stringify(LAYER)}`, `layer info 600 ${JSON.stringify(LAYER)}`]);
    const file = JSON.parse(readFileSync(`${dump}.deploy`, 'utf8')).ARCO_CONFIG_LAYER;
    expect(file).toMatch(/config-layer\.json$/);
    expect(JSON.parse(readFileSync(`${dump}.info`, 'utf8')).ARCO_CONFIG_LAYER).toBe(file);
    expect(existsSync(file)).toBe(false);
    expect(finish.body).toMatchObject({ result: 'succeeded', arco_version: '0.13.0' });
  });

  it('checks the Arco version once, before deploying', async () => {
    const { callsFile } = await run();
    const commands = readFileSafe(callsFile).split('\n').filter((l) => l !== '' && !l.startsWith('layer ')).map((l) => l.split(' ')[0]);
    expect(commands).toEqual(['--version', 'deploy', 'info']);
  });

  it.each([
    ['0.12.1', '0.12.1'],
    ['fail', 'an unknown version'],
  ])('fails as config.arco_outdated without deploying when Arco is %s', async (version, shown) => {
    const { code, callsFile, finish } = await run({ FAKE_ARCO_VERSION: version });
    expect(code).toBe(1);
    expect(readFileSafe(callsFile)).not.toMatch(/^(deploy|info)/m);
    expect(finish.body).toMatchObject({ result: 'failed', error_code: 'config.arco_outdated', rolled_back: false, revision: null });
    expect(finish.body.error_message).toContain(`the project has ${shown}`);
  });

  it('accepts a later Arco', async () => {
    const { code } = await run({ FAKE_ARCO_VERSION: '1.0.0-beta.1' });
    expect(code).toBe(0);
  });

  it('removes the file when arco exits non-zero', async () => {
    const { code, dump } = await run({ FAKE_ARCO_SCENARIO: 'failed' });
    expect(code).toBe(1);
    expect(existsSync(JSON.parse(readFileSync(`${dump}.deploy`, 'utf8')).ARCO_CONFIG_LAYER)).toBe(false);
  });

  it('finishes the run as config.layer_file_failed when the file cannot be written, without deploying', async () => {
    const { code, callsFile, finish } = await run({}, { layerDir: join(project, 'does-not-exist') });
    expect(code).toBe(1);
    expect(readFileSafe(callsFile)).not.toMatch(/^(deploy|info)/m);
    expect(finish.body).toMatchObject({ result: 'failed', error_code: 'config.layer_file_failed', arco_version: '0.13.0' });
  });

  it('runs no version check and sets no ARCO_CONFIG_LAYER without a layer', async () => {
    startExtra = { config: null };
    const { code, callsFile, dump } = await run({ FAKE_ARCO_VERSION: '0.12.1' });
    expect(code).toBe(0);
    expect(layerLines(callsFile)).toEqual([]);
    expect(JSON.parse(readFileSync(`${dump}.deploy`, 'utf8'))).not.toHaveProperty('ARCO_CONFIG_LAYER');
    expect(readFileSafe(callsFile).split('\n')[0]!.split(' ')[0]).toBe('deploy');
  });
});

describe('extensions', () => {
  const OUTDATED = 'Cloud says: update multiapi/arco-laravel to 0.6 or later.';
  const BOOT = tarball([{ name: 'bootstrap.php', content: '<?php return 1;' }]);
  const extension = (body: Buffer, extra: Record<string, unknown> = {}) => ({
    version: '1.0.0',
    url: 'https://ext.test/sample.tar.gz?X-Amz-Signature=presigned',
    sha256: sha256(body),
    config: { enabled: true, rate: 0.5 },
    ...extra,
  });
  beforeEach(() => {
    downloads = { 'sample.tar.gz': BOOT };
    startExtra = { extensions: { sample: extension(BOOT) } };
  });
  const installed = (version: string) => {
    mkdirSync(join(project, 'vendor/composer'), { recursive: true });
    writeFileSync(join(project, 'vendor/composer/installed.json'), JSON.stringify({ packages: [{ name: 'multiapi/arco-laravel', version }] }));
  };
  const commit = () => {
    mkdirSync(join(project, '.arco-cloud/sample'), { recursive: true });
    writeFileSync(join(project, '.arco-cloud/sample/config.json'), '{"licence":"committed"}');
  };
  const run = async (mode: 'deploy' | 'inventory' = 'deploy', extra: NodeJS.ProcessEnv = {}) => {
    const callsFile = join(project, 'calls.txt');
    const treeFile = join(project, 'tree.json');
    const s = await session();
    const code = await deployAndFinish(s, dep(mode, { ...process.env, FAKE_ARCO_CALLS: callsFile, FAKE_ARCO_TREE: treeFile, ...extra }));
    const tree = existsSync(treeFile) ? JSON.parse(readFileSync(treeFile, 'utf8')) : undefined;
    const logged = calls.filter((c) => c.path === 'logs').flatMap((c) => c.body.lines as string[]);
    return { code, callsFile, tree, logged, finish: calls.at(-1)! };
  };
  const deployed = (callsFile: string) => /^deploy /m.test(readFileSafe(callsFile));

  it('removes a committed .arco-cloud before deploying, even without extensions', async () => {
    startExtra = {};
    commit();
    const { code, tree, logged } = await run();
    expect(code).toBe(0);
    expect(tree).toBeNull();
    expect(logged).toContain('Removed an existing .arco-cloud directory from the checkout.');
  });

  it('extracts and writes config.json', async () => {
    const { code, tree, logged, finish } = await run();
    expect(code).toBe(0);
    expect(tree).toEqual({ 'sample/bootstrap.php': '<?php return 1;', 'sample/config.json': JSON.stringify({ enabled: true, rate: 0.5 }) });
    expect(logged).toContain('Added the Arco Cloud extension sample 1.0.0.');
    expect(JSON.stringify(calls)).not.toContain('X-Amz-Signature');
    expect(finish.body).toMatchObject({ result: 'succeeded' });
  });

  it('replaces a committed copy with the one from Cloud', async () => {
    commit();
    const { tree } = await run();
    expect(tree['sample/config.json']).toBe(JSON.stringify({ enabled: true, rate: 0.5 }));
  });

  it('fails the run on a checksum mismatch before arco deploy runs', async () => {
    startExtra = { extensions: { sample: extension(BOOT, { sha256: 'c'.repeat(64) }) } };
    const { code, callsFile, finish } = await run();
    expect(code).toBe(1);
    expect(deployed(callsFile)).toBe(false);
    expect(finish.body).toMatchObject({ result: 'failed', error_code: 'extensions.failed', error_message: 'The sample extension did not match its checksum' });
    expect(existsSync(join(project, '.arco-cloud'))).toBe(false);
  });

  it('refuses a tarball entry that escapes the directory', async () => {
    const evil = tarball([{ name: 'bootstrap.php', content: 'x' }, { name: '../../escaped.php', content: 'x' }]);
    downloads = { 'sample.tar.gz': evil };
    startExtra = { extensions: { sample: extension(evil) } };
    const { code, callsFile, finish } = await run();
    expect(code).toBe(1);
    expect(deployed(callsFile)).toBe(false);
    expect(finish.body).toMatchObject({ result: 'failed', error_code: 'extensions.failed' });
    expect(finish.body.error_message).toContain('outside its directory or a link');
    expect(existsSync(join(project, '.arco-cloud'))).toBe(false);
  });

  it('fails as extensions.failed when the download fails, without the URL', async () => {
    downloads = {};
    const { code, callsFile, finish } = await run();
    expect(code).toBe(1);
    expect(deployed(callsFile)).toBe(false);
    expect(finish.body).toMatchObject({ error_code: 'extensions.failed', error_message: 'Could not download the sample extension: HTTP 404' });
  });

  it('fails with extensions.arco_laravel_outdated when the lock has an older arco-laravel', async () => {
    installed('v0.5.2');
    startExtra = { extensions: { sample: extension(BOOT, { min_arco_laravel: '0.6.0', message_outdated: OUTDATED }) } };
    const { code, callsFile, finish, logged } = await run();
    expect(code).toBe(1);
    expect(deployed(callsFile)).toBe(false);
    expect(finish.body).toMatchObject({ result: 'failed', error_code: 'extensions.arco_laravel_outdated', error_message: OUTDATED, rolled_back: false });
    expect(logged).toContain(OUTDATED);
  });

  it('fails with extensions.arco_laravel_outdated when arco-laravel is not installed', async () => {
    startExtra = { extensions: { sample: extension(BOOT, { min_arco_laravel: '0.6.0', message_outdated: OUTDATED }) } };
    const { code, finish } = await run();
    expect(code).toBe(1);
    expect(finish.body).toMatchObject({ error_code: 'extensions.arco_laravel_outdated', error_message: OUTDATED });
  });

  it('words the outdated failure itself when Cloud sent no message', async () => {
    installed('0.5.0');
    startExtra = { extensions: { sample: extension(BOOT, { min_arco_laravel: '0.6.0' }) } };
    const { finish } = await run();
    expect(finish.body.error_code).toBe('extensions.arco_laravel_outdated');
    expect(finish.body.error_message).toBe('The sample extension needs multiapi/arco-laravel 0.6.0 or later; the project has 0.5.0.');
  });

  it.each([['0.6.0'], ['v0.7.1'], ['dev-main']])('deploys with arco-laravel %s', async (version) => {
    installed(version);
    startExtra = { extensions: { sample: extension(BOOT, { min_arco_laravel: '0.6.0', message_outdated: OUTDATED }) } };
    const { code, tree, logged } = await run();
    expect(code).toBe(0);
    expect(tree).toHaveProperty(['sample/bootstrap.php']);
    if (version === 'dev-main') expect(logged).toContain('multiapi/arco-laravel is dev-main, a development version: taking it as recent enough for the sample extension.');
  });

  it('removes .arco-cloud after the deploy, success or failure', async () => {
    for (const scenario of ['deployed', 'failed', 'crash']) {
      calls = [];
      const { tree } = await run('deploy', { FAKE_ARCO_SCENARIO: scenario });
      expect(tree).toHaveProperty(['sample/bootstrap.php']);
      expect(existsSync(join(project, '.arco-cloud'))).toBe(false);
    }
  });

  it('leaves the checkout alone in inventory mode', async () => {
    commit();
    const { code } = await run('inventory');
    expect(code).toBe(0);
    expect(existsSync(join(project, '.arco-cloud/sample/config.json'))).toBe(true);
  });

  it('refuses a start answer with malformed extensions', async () => {
    startExtra = { extensions: { 'Bad/Key': extension(BOOT) } };
    await expect(session()).rejects.toThrow('Arco Cloud start answer was malformed (extensions)');
    expect(calls.at(-1)).toMatchObject({ path: 'finish', body: { result: 'failed', error_code: 'cloud.start_answer_invalid' } });
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

describe('arco binary', () => {
  /** A directory holding an executable `arco` (the fake), like Composer's global bin dir; the project loses vendor/. */
  const globalArco = () => {
    const bin = mkdtempSync(join(tmpdir(), 'arco-global-'));
    writeFileSync(join(bin, 'arco'), `#!/bin/sh\nexec node "${resolve(__dirname, 'fixtures/fake-arco.mjs')}" "$@"\n`);
    chmodSync(join(bin, 'arco'), 0o755);
    rmSync(join(project, 'vendor'), { recursive: true });
    return bin;
  };
  const spawnedFiles = () => vi.mocked(spawn).mock.calls.map((c) => c[0]);

  it('resolveArcoBin: input, then ARCO_BIN, then vendor/bin/arco', () => {
    expect(ARCO_BIN).toBe('vendor/bin/arco');
    expect(resolveArcoBin()).toBe('vendor/bin/arco');
    expect(resolveArcoBin('', {})).toBe('vendor/bin/arco');
    expect(resolveArcoBin('  ', { ARCO_BIN: ' ' })).toBe('vendor/bin/arco');
    expect(resolveArcoBin(undefined, { ARCO_BIN: 'arco' })).toBe('arco');
    expect(resolveArcoBin('bin/arco', { ARCO_BIN: 'arco' })).toBe('bin/arco');
    expect(resolveArcoBin(' arco ')).toBe('arco');
  });

  it('runs vendor/bin/arco by default for every command', async () => {
    const s = await session();
    expect(await deployAndFinish(s, dep('deploy', { ...process.env, ARCO_BIN: undefined }))).toBe(0);
    expect(spawnedFiles()).toEqual(['vendor/bin/arco', 'vendor/bin/arco', 'vendor/bin/arco']);
  });

  it('arcoBin "arco" resolves through PATH for a project without vendor/', async () => {
    const bin = globalArco();
    const callsFile = join(project, 'calls.txt');
    const s = await session();
    const env = { ...process.env, ARCO_BIN: undefined, PATH: `${bin}:${process.env.PATH}`, FAKE_ARCO_CALLS: callsFile };
    expect(await deployAndFinish(s, { ...dep('deploy', env), arcoBin: 'arco' })).toBe(0);
    expect(spawnedFiles()).toEqual(['arco', 'arco', 'arco']);
    expect(readFileSync(callsFile, 'utf8').trim().split('\n')).toEqual(['deploy --env=production --yes --json', 'info --env=production --resources --json', '--version']);
    expect(calls.at(-1)!.body).toMatchObject({ result: 'succeeded', revision: 'r42', arco_version: '0.10.0' });
  });

  it('ARCO_BIN in the environment overrides the default, including the config layer version check', async () => {
    const bin = globalArco();
    startExtra = { config: { schema: 1, app: 'shop', environments: { production: {} } } };
    const s = await session();
    expect(await deployAndFinish(s, dep('deploy', { ...process.env, ARCO_BIN: 'arco', PATH: `${bin}:${process.env.PATH}`, FAKE_ARCO_VERSION: '0.13.0' }))).toBe(0);
    expect(new Set(spawnedFiles())).toEqual(new Set(['arco']));
    expect(spawnedFiles()[0]).toBe('arco');
  });

  it('a bare name missing from PATH fails the run instead of falling back to vendor/bin/arco', async () => {
    const s = await session();
    const code = await deployAndFinish(s, { ...dep('deploy', { ...process.env, PATH: '/nonexistent' }), arcoBin: 'arco' });
    expect(code).not.toBe(0);
    expect(spawnedFiles().every((f) => f === 'arco')).toBe(true);
    expect(calls.at(-1)!.body).toMatchObject({ result: 'failed', error_code: 'arco.no_result' });
  });
});
