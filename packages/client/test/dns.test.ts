import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), chown: vi.fn(actual.chown) };
});

import { chown, writeFile } from 'node:fs/promises';
import { CloudApi, parseExternalDns, withExternalDns, type ExternalDns } from '../src/index.js';

const DNS: ExternalDns = {
  profile: 'arco-cloud-dns',
  credentials: { accessKeyId: 'ASIADNSKEY123', secretAccessKey: 'dnsSecret/abc+123', sessionToken: 'dnsSession-token-xyz', expiration: '2026-10-28T13:00:00Z' },
};

describe('parseExternalDns', () => {
  it('accepts the Cloud shape', () => {
    expect(parseExternalDns({ credentials: {}, dns: DNS, cloudflareToken: 'cf-token-123' })).toEqual({ dns: DNS, cloudflareToken: 'cf-token-123' });
  });

  it('accepts explicit nulls', () => {
    expect(parseExternalDns({ dns: null, cloudflareToken: null })).toEqual({ dns: null, cloudflareToken: null });
  });

  it('returns both null when the fields are absent (older Cloud, deferred start)', () => {
    expect(parseExternalDns({ region: 'us-east-1' })).toEqual({ dns: null, cloudflareToken: null });
  });

  it('throws on a non-string cloudflareToken', () => {
    expect(() => parseExternalDns({ cloudflareToken: 42 })).toThrow(/Arco Cloud start answer was malformed/);
  });

  it('throws on an unsafe profile', () => {
    expect(() => parseExternalDns({ dns: { ...DNS, profile: '../x' } })).toThrow(/malformed/);
    expect(() => parseExternalDns({ dns: { ...DNS, profile: 'a]\n[b' } })).toThrow(/malformed/);
    expect(() => parseExternalDns({ dns: { ...DNS, profile: 'x'.repeat(65) } })).toThrow(/malformed/);
  });

  it('throws on missing or unsafe credentials', () => {
    expect(() => parseExternalDns({ dns: { profile: 'arco-cloud-dns' } })).toThrow(/malformed/);
    expect(() => parseExternalDns({ dns: { ...DNS, credentials: { ...DNS.credentials, sessionToken: 7 } } })).toThrow(/malformed/);
    expect(() => parseExternalDns({ dns: { ...DNS, credentials: { ...DNS.credentials, secretAccessKey: 'a\n[default]' } } })).toThrow(/malformed/);
    expect(() => parseExternalDns({ dns: 'yes' })).toThrow(/malformed/);
  });

  it('names the answer it was parsing', () => {
    expect(() => parseExternalDns({ cloudflareToken: [] }, 'credentials')).toThrow(/Arco Cloud credentials answer was malformed/);
  });
});

describe('withExternalDns', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'arco-dns-test-'));
    vi.mocked(chown).mockClear();
  });

  it('writes the profile file with mode 0600 and appends the flag', async () => {
    const r = await withExternalDns({ PATH: '/bin' }, ['deploy', '--json'], { dns: DNS, cloudflareToken: null }, dir);
    const file = r.env.AWS_SHARED_CREDENTIALS_FILE!;
    expect(dirname(dirname(file))).toBe(dir);
    expect(readFileSync(file, 'utf8')).toBe(
      '[arco-cloud-dns]\naws_access_key_id = ASIADNSKEY123\naws_secret_access_key = dnsSecret/abc+123\naws_session_token = dnsSession-token-xyz\n',
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.args).toEqual(['deploy', '--json', '--dns-profile=arco-cloud-dns']);
    expect(r.env.PATH).toBe('/bin');
    expect(r.env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    await r.cleanup();
    expect(existsSync(dirname(file))).toBe(false);
  });

  it('sets CLOUDFLARE_API_TOKEN only when a token is given, without writing a file', async () => {
    const r = await withExternalDns({ PATH: '/bin' }, ['deploy'], { dns: null, cloudflareToken: 'cf-token-123' }, dir);
    expect(r.env).toEqual({ PATH: '/bin', CLOUDFLARE_API_TOKEN: 'cf-token-123' });
    expect(r.args).toEqual(['deploy']);
    expect(readdirSync(dir)).toEqual([]);
    await r.cleanup();
  });

  it('changes nothing when both are null', async () => {
    const env = { PATH: '/bin' };
    const args = ['deploy'];
    const r = await withExternalDns(env, args, { dns: null, cloudflareToken: null }, dir);
    expect(r.env).toEqual({ PATH: '/bin' });
    expect(r.args).toEqual(['deploy']);
    expect(readdirSync(dir)).toEqual([]);
    await r.cleanup();
  });

  it('does not modify the env and args it was given', async () => {
    const env = { PATH: '/bin' };
    const args = ['deploy'];
    const r = await withExternalDns(env, args, { dns: DNS, cloudflareToken: 'cf-token-123' }, dir);
    expect(env).toEqual({ PATH: '/bin' });
    expect(args).toEqual(['deploy']);
    await r.cleanup();
  });

  it('removes the temporary directory and rethrows when the write fails', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    await expect(withExternalDns({ PATH: '/bin' }, ['deploy'], { dns: DNS, cloudflareToken: null }, dir)).rejects.toThrow(/ENOSPC/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('hands the directory and the file to the child uid/gid', async () => {
    vi.mocked(chown).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const r = await withExternalDns({ PATH: '/bin' }, ['deploy'], { dns: DNS, cloudflareToken: null }, dir, { uid: 1001, gid: 1002 });
    const file = r.env.AWS_SHARED_CREDENTIALS_FILE!;
    expect(vi.mocked(chown).mock.calls).toEqual([
      [dirname(file), 1001, 1002],
      [file, 1001, 1002],
    ]);
    await r.cleanup();
  });

  it('leaves the other id unchanged (-1) when only one is given', async () => {
    vi.mocked(chown).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const r = await withExternalDns({ PATH: '/bin' }, ['deploy'], { dns: DNS, cloudflareToken: null }, dir, { uid: 1001 });
    expect(vi.mocked(chown).mock.calls.map(([, uid, gid]) => [uid, gid])).toEqual([[1001, -1], [1001, -1]]);
    await r.cleanup();
  });

  it('does not chown without an owner', async () => {
    const r = await withExternalDns({ PATH: '/bin' }, ['deploy'], { dns: DNS, cloudflareToken: null }, dir, {});
    expect(chown).not.toHaveBeenCalled();
    await r.cleanup();
  });

  it('removes the temporary directory and rethrows when the chown fails', async () => {
    vi.mocked(chown).mockRejectedValueOnce(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));
    await expect(withExternalDns({ PATH: '/bin' }, ['deploy'], { dns: DNS, cloudflareToken: null }, dir, { uid: 1001, gid: 1002 })).rejects.toThrow(/EPERM/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('treats undefined fields from a JavaScript caller as absent', async () => {
    const x = {} as unknown as Parameters<typeof withExternalDns>[2];
    const r = await withExternalDns({ PATH: '/bin' }, ['deploy'], x, dir, undefined);
    expect(r.env).toEqual({ PATH: '/bin' });
    expect(r.args).toEqual(['deploy']);
    expect(readdirSync(dir)).toEqual([]);

    const owner = { uid: undefined, gid: null } as unknown as { uid?: number; gid?: number };
    const withFile = await withExternalDns({ PATH: '/bin' }, ['deploy'], { dns: DNS, cloudflareToken: undefined } as unknown as Parameters<typeof withExternalDns>[2], dir, owner);
    expect(withFile.env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    expect(withFile.args).toEqual(['deploy', '--dns-profile=arco-cloud-dns']);
    await withFile.cleanup();
  });
});

describe('CloudApi.start', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the external_dns capability and config layer support', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Response.json({ credentials: {}, region: 'us-east-1' });
    });
    await new CloudApi('https://cloud.test', 'tok', 'dep_1').start('nonce-1');
    expect(bodies[0]).toEqual({ nonce: 'nonce-1', capabilities: ['external_dns'], supports_config_layer: true });
  });
});
