import { chmod, chown, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Credentials } from './api.js';

/** Route 53 credentials for a DNS zone in another AWS account, handed to Arco as a named profile. */
export interface ExternalDns {
  profile: string;
  credentials: Credentials;
}

export interface ExternalDnsAnswer {
  dns: ExternalDns | null;
  cloudflareToken: string | null;
}

const PROFILE = /^[A-Za-z0-9_-]{1,64}$/;
// Values are written to an INI file: a line break or other control character could inject another profile or key.
const SAFE_VALUE = /^[^\x00-\x1f\x7f]+$/;

/**
 * Reads `dns` and `cloudflareToken` from a start or credentials answer. Absent keys (deferred start,
 * inventory runs, older Cloud) mean null; anything of the wrong shape throws.
 */
export function parseExternalDns(answer: unknown, path = 'start'): ExternalDnsAnswer {
  const malformed = (field: string) => new Error(`Arco Cloud ${path} answer was malformed (${field})`);
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) throw malformed('answer');
  const { dns, cloudflareToken } = answer as Record<string, unknown>;

  if (cloudflareToken !== undefined && cloudflareToken !== null && typeof cloudflareToken !== 'string') throw malformed('cloudflareToken');

  let parsed: ExternalDns | null = null;
  if (dns !== undefined && dns !== null) {
    if (typeof dns !== 'object' || Array.isArray(dns)) throw malformed('dns');
    const { profile, credentials } = dns as Record<string, unknown>;
    if (typeof profile !== 'string' || !PROFILE.test(profile)) throw malformed('dns.profile');
    if (credentials === null || typeof credentials !== 'object' || Array.isArray(credentials)) throw malformed('dns.credentials');
    const c = credentials as Record<string, unknown>;
    for (const key of ['accessKeyId', 'secretAccessKey', 'sessionToken', 'expiration']) {
      if (typeof c[key] !== 'string' || !SAFE_VALUE.test(c[key] as string)) throw malformed(`dns.credentials.${key}`);
    }
    parsed = {
      profile,
      credentials: {
        accessKeyId: c.accessKeyId as string,
        secretAccessKey: c.secretAccessKey as string,
        sessionToken: c.sessionToken as string,
        expiration: c.expiration as string,
      },
    };
  }

  // An empty token is no token.
  return { dns: parsed, cloudflareToken: typeof cloudflareToken === 'string' && cloudflareToken !== '' ? cloudflareToken : null };
}

export interface ExternalDnsChild {
  env: NodeJS.ProcessEnv;
  args: string[];
  /** Removes the credentials file; safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Prepares a child for external DNS: writes the DNS credentials to a 0600 shared credentials file in a fresh
 * temporary directory (AWS_SHARED_CREDENTIALS_FILE), appends `--dns-profile=<profile>`, and sets
 * CLOUDFLARE_API_TOKEN. With neither, env and args come back unchanged. `owner` hands the file to the
 * child's uid/gid when it runs as another user.
 */
export async function withExternalDns(
  env: NodeJS.ProcessEnv,
  args: string[],
  x: ExternalDnsAnswer,
  dir?: string,
  owner: { uid?: number; gid?: number } = {},
): Promise<ExternalDnsChild> {
  const outEnv: NodeJS.ProcessEnv = { ...env };
  const outArgs = [...args];
  let cleanup = async () => {};

  if (x.dns !== null) {
    const tmp = await mkdtemp(join(dir ?? tmpdir(), 'arco-dns-'));
    cleanup = () => rm(tmp, { recursive: true, force: true });
    try {
      const file = join(tmp, 'credentials');
      const { accessKeyId, secretAccessKey, sessionToken } = x.dns.credentials;
      await writeFile(
        file,
        `[${x.dns.profile}]\naws_access_key_id = ${accessKeyId}\naws_secret_access_key = ${secretAccessKey}\naws_session_token = ${sessionToken}\n`,
        { mode: 0o600 },
      );
      await chmod(file, 0o600);
      if (owner.uid !== undefined || owner.gid !== undefined) {
        const uid = owner.uid ?? -1;
        const gid = owner.gid ?? -1;
        await chown(tmp, uid, gid);
        await chown(file, uid, gid);
      }
      outEnv.AWS_SHARED_CREDENTIALS_FILE = file;
      outArgs.push(`--dns-profile=${x.dns.profile}`);
    } catch (e) {
      await cleanup();
      throw e;
    }
  }
  if (x.cloudflareToken !== null) outEnv.CLOUDFLARE_API_TOKEN = x.cloudflareToken;

  return { env: outEnv, args: outArgs, cleanup };
}
