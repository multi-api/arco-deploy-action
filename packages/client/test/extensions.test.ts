import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudApi, parseExtensions } from '../src/index.js';

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
