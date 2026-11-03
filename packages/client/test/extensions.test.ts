import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudApi, arcoLaravelVersion, parseExtensions, satisfiesMinVersion, withExtensions, type Extension } from '../src/index.js';
import { sha256, tarball, type TarEntry } from './helpers/tarball.js';

const EXT = {
  version: '1.0.0',
  url: 'https://cloud.test/ext/sample-1.0.0.tar.gz',
  sha256: 'a'.repeat(64),
  config: { enabled: true, rate: 0.5 },
};

describe('parseExtensions', () => {
  it('absent means none', () => {
    expect(parseExtensions({})).toEqual({});
    expect(parseExtensions({ extensions: null })).toEqual({});
    expect(parseExtensions(undefined)).toEqual({});
  });

  it('parses one extension', () => {
    expect(parseExtensions({ extensions: { sample: EXT } })).toEqual({ sample: EXT });
    const full = { ...EXT, min_arco_laravel: '0.5.0', message_outdated: 'Update the package.' };
    expect(parseExtensions({ extensions: { 'sample-2': full } })).toEqual({ 'sample-2': full });
  });

  it.each([
    ['a bad key', { Sample: EXT }],
    ['a key with a slash', { 'a/b': EXT }],
    ['a key with dots', { '..': EXT }],
    ['a missing sha256', { sample: { ...EXT, sha256: undefined } }],
    ['a sha256 that is not hex', { sample: { ...EXT, sha256: 'z'.repeat(64) } }],
    ['a missing url', { sample: { ...EXT, url: '' } }],
    ['a missing version', { sample: { ...EXT, version: 1 } }],
    ['a config that is not an object', { sample: { ...EXT, config: [] } }],
    ['a non-string min_arco_laravel', { sample: { ...EXT, min_arco_laravel: 5 } }],
    ['a non-string message_outdated', { sample: { ...EXT, message_outdated: {} } }],
    ['an extension that is not an object', { sample: 'x' }],
    ['an array', [EXT]],
    ['a string', 'sample'],
  ])('rejects %s', (_, extensions) => {
    expect(() => parseExtensions({ extensions })).toThrow('Arco Cloud start answer was malformed (extensions)');
  });
});

describe('CloudApi.start', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('start advertises the extensions capability', async () => {
    let body: any;
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return Response.json({});
    });
    await new CloudApi('https://cloud.test', 't', 'dep_1').start('n');
    expect(body.capabilities).toEqual(['external_dns', 'extensions']);
    expect(body.supports_config_layer).toBe(true);
  });
});

describe('withExtensions', () => {
  let cwd: string;
  let lines: string[];
  const log = (line: string) => lines.push(line);
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'arco-ext-'));
    lines = [];
  });
  const serve = (body: Buffer, status = 200) => vi.fn(async () => new Response(status === 200 ? body : null, { status })) as unknown as typeof fetch;
  const ext = (body: Buffer, extra: Partial<Extension> = {}): Extension => ({
    version: '1.0.0',
    url: 'https://ext.test/sample.tar.gz?X-Amz-Signature=abc',
    sha256: sha256(body),
    config: { enabled: true },
    ...extra,
  });
  const BOOT: TarEntry[] = [{ name: 'src/', type: '5' }, { name: 'bootstrap.php', content: '<?php return 1;' }, { name: 'src/A.php', content: '<?php' }];

  it('removes a committed .arco-cloud even without extensions, and says so', async () => {
    mkdirSync(join(cwd, '.arco-cloud/sample'), { recursive: true });
    writeFileSync(join(cwd, '.arco-cloud/sample/config.json'), '{"licence":"committed"}');
    const result = await withExtensions(cwd, {}, serve(Buffer.alloc(0)), log);
    expect(existsSync(join(cwd, '.arco-cloud'))).toBe(false);
    expect(lines).toEqual(['Removed an existing .arco-cloud directory from the checkout.']);
    await result.cleanup();
  });

  it('says nothing when there was no .arco-cloud', async () => {
    await (await withExtensions(cwd, {}, serve(Buffer.alloc(0)), log)).cleanup();
    expect(lines).toEqual([]);
  });

  it('extracts and writes config.json, and cleanup removes .arco-cloud (twice is fine)', async () => {
    const body = tarball(BOOT);
    const fetchImpl = serve(body);
    const result = await withExtensions(cwd, { sample: ext(body, { config: { a: 1, nested: { b: [2] } } }) }, fetchImpl, log);
    expect(fetchImpl).toHaveBeenCalledWith('https://ext.test/sample.tar.gz?X-Amz-Signature=abc', expect.anything());
    expect(readFileSync(join(cwd, '.arco-cloud/sample/bootstrap.php'), 'utf8')).toBe('<?php return 1;');
    expect(readFileSync(join(cwd, '.arco-cloud/sample/src/A.php'), 'utf8')).toBe('<?php');
    expect(JSON.parse(readFileSync(join(cwd, '.arco-cloud/sample/config.json'), 'utf8'))).toEqual({ a: 1, nested: { b: [2] } });
    expect(lines.join('\n')).not.toContain('X-Amz-Signature');
    await result.cleanup();
    await result.cleanup();
    expect(existsSync(join(cwd, '.arco-cloud'))).toBe(false);
  });

  it('overwrites a config.json shipped in the tarball', async () => {
    const body = tarball([...BOOT, { name: 'config.json', content: '{"from":"tarball"}' }]);
    await withExtensions(cwd, { sample: ext(body) }, serve(body), log);
    expect(JSON.parse(readFileSync(join(cwd, '.arco-cloud/sample/config.json'), 'utf8'))).toEqual({ enabled: true });
  });

  it('downloads to a temporary file outside the checkout and removes it', async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('arco-ext-dl-'));
    const body = tarball(BOOT);
    await withExtensions(cwd, { sample: ext(body) }, serve(body), log);
    expect(readdirSync(cwd)).toEqual(['.arco-cloud']);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('arco-ext-dl-'))).toEqual(before);
  });

  it('fails on a checksum mismatch before extracting anything', async () => {
    const body = tarball(BOOT);
    await expect(withExtensions(cwd, { sample: ext(body, { sha256: 'b'.repeat(64) }) }, serve(body), log)).rejects.toThrow(
      'The sample extension did not match its checksum',
    );
    expect(existsSync(join(cwd, '.arco-cloud'))).toBe(false);
  });

  it('fails on a download error, naming the key and status only', async () => {
    const error = withExtensions(cwd, { sample: ext(Buffer.alloc(0)) }, serve(Buffer.alloc(0), 403), log);
    await expect(error).rejects.toThrow('Could not download the sample extension: HTTP 403');
    await expect(error).rejects.not.toThrow(/X-Amz/);
    expect(existsSync(join(cwd, '.arco-cloud'))).toBe(false);
  });

  it.each([
    ['a parent segment', [{ name: '../escaped.php', content: 'x' }]],
    ['a nested parent segment', [{ name: 'src/../../escaped.php', content: 'x' }]],
    ['an absolute path', [{ name: '/tmp/arco-ext-absolute.php', content: 'x' }]],
    ['a symlink', [{ name: 'link', type: '2', linkname: '/etc/passwd' }]],
    ['a hard link', [{ name: 'bootstrap.php', content: 'x' }, { name: 'hard', type: '1', linkname: 'bootstrap.php' }]],
  ] as [string, TarEntry[]][])('refuses a tarball entry with %s', async (_, entries) => {
    const body = tarball([...BOOT, ...entries]);
    await expect(withExtensions(cwd, { sample: ext(body) }, serve(body), log)).rejects.toThrow(
      'The sample extension archive has an entry outside its directory or a link',
    );
    expect(existsSync(join(cwd, '.arco-cloud'))).toBe(false);
    expect(existsSync(join(cwd, 'escaped.php'))).toBe(false);
    expect(existsSync('/tmp/arco-ext-absolute.php')).toBe(false);
  });

  it('extracts several extensions, each into its own directory', async () => {
    const a = tarball([{ name: 'bootstrap.php', content: 'a' }]);
    const b = tarball([{ name: 'bootstrap.php', content: 'b' }]);
    const fetchImpl = vi.fn(async (url: string) => new Response(url.endsWith('/a') ? a : b)) as unknown as typeof fetch;
    await withExtensions(cwd, { one: ext(a, { url: 'https://ext.test/a' }), two: ext(b, { url: 'https://ext.test/b' }) }, fetchImpl, log);
    expect(readFileSync(join(cwd, '.arco-cloud/one/bootstrap.php'), 'utf8')).toBe('a');
    expect(readFileSync(join(cwd, '.arco-cloud/two/bootstrap.php'), 'utf8')).toBe('b');
    expect(lstatSync(join(cwd, '.arco-cloud/two/config.json')).isFile()).toBe(true);
  });
});

describe('arcoLaravelVersion', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'arco-ext-'));
    mkdirSync(join(cwd, 'vendor/composer'), { recursive: true });
  });
  const installed = (value: unknown) => writeFileSync(join(cwd, 'vendor/composer/installed.json'), JSON.stringify(value));

  it('reads the Composer 2 format', () => {
    installed({ packages: [{ name: 'laravel/framework', version: 'v12.0.0' }, { name: 'multiapi/arco-laravel', version: 'v0.6.1' }], dev: true });
    expect(arcoLaravelVersion(cwd)).toBe('v0.6.1');
  });

  it('reads the Composer 1 format', () => {
    installed([{ name: 'multiapi/arco-laravel', version: '0.6.1' }]);
    expect(arcoLaravelVersion(cwd)).toBe('0.6.1');
  });

  it('is null when the package, the file or valid JSON is missing', () => {
    installed({ packages: [{ name: 'laravel/framework', version: 'v12.0.0' }] });
    expect(arcoLaravelVersion(cwd)).toBeNull();
    writeFileSync(join(cwd, 'vendor/composer/installed.json'), 'not json');
    expect(arcoLaravelVersion(cwd)).toBeNull();
    expect(arcoLaravelVersion(join(cwd, 'nowhere'))).toBeNull();
  });
});

describe('satisfiesMinVersion', () => {
  it.each([
    ['0.6.0', '0.6.0', true],
    ['v0.6.1', '0.6.0', true],
    ['0.6.0', 'v0.6.0', true],
    ['1.0', '0.6.0', true],
    ['0.10.0', '0.9.9', true],
    ['0.6.0-beta.1', '0.6.0', true],
    ['0.5.9', '0.6.0', false],
    ['v0.5.0', '0.6', false],
    ['dev-main', '0.6.0', true],
    ['1.x-dev', '0.6.0', true],
    [null, '0.6.0', false],
    ['garbage', '0.6.0', false],
  ])('%s against %s -> %s', (version, min, expected) => {
    expect(satisfiesMinVersion(version, min)).toBe(expected);
  });
});
