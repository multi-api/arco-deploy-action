import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Arco Cloud extensions: opaque packages Cloud asks the client to place in the checkout before `arco deploy`. The
 * client knows only a key, a tarball (URL + sha256), a JSON config to write next to it, and an optional minimum
 * multiapi/arco-laravel version with the message to show when the project is older.
 */
export interface Extension {
  version: string;
  url: string;
  sha256: string;
  config: Record<string, unknown>;
  min_arco_laravel?: string;
  message_outdated?: string;
}

/** An extension key: also its directory name under `.arco-cloud/`, so never a path. */
export const EXTENSION_KEY = /^[a-z][a-z0-9-]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

/**
 * Reads `extensions` from a start answer. Absent (older Cloud) or null means none; anything malformed throws. The
 * error names the field only, never a value.
 */
export function parseExtensions(answer: unknown): Record<string, Extension> {
  const { extensions } = (isObject(answer) ? answer : {}) as Record<string, unknown>;
  if (extensions === undefined || extensions === null) return {};
  const malformed = () => new Error('Arco Cloud start answer was malformed (extensions)');
  if (!isObject(extensions)) throw malformed();

  const parsed: Record<string, Extension> = {};
  for (const [key, value] of Object.entries(extensions)) {
    if (!EXTENSION_KEY.test(key) || !isObject(value)) throw malformed();
    const { version, url, sha256, config, min_arco_laravel: minArcoLaravel, message_outdated: messageOutdated } = value;
    if (!isNonEmptyString(version) || !isNonEmptyString(url) || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) throw malformed();
    if (!isObject(config)) throw malformed();
    if (minArcoLaravel !== undefined && minArcoLaravel !== null && !isNonEmptyString(minArcoLaravel)) throw malformed();
    if (messageOutdated !== undefined && messageOutdated !== null && typeof messageOutdated !== 'string') throw malformed();

    const extension: Extension = { version, url, sha256: sha256.toLowerCase(), config };
    if (isNonEmptyString(minArcoLaravel)) extension.min_arco_laravel = minArcoLaravel;
    if (typeof messageOutdated === 'string') extension.message_outdated = messageOutdated;
    parsed[key] = extension;
  }
  return parsed;
}

/** Where extensions live in the checkout: `<cwd>/.arco-cloud/<key>/`. A copy committed to the repository never ships. */
export const EXTENSIONS_DIR = '.arco-cloud';

/** Per-download timeout (connect, headers and body). */
const DOWNLOAD_TIMEOUT_MS = 120_000;

const run = promisify(execFile);
const tar = async (args: string[]) => (await run('tar', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;

const exists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

export interface ExtensionsChild {
  /** Removes `<cwd>/.arco-cloud/`; safe to call more than once. */
  cleanup(): Promise<void>;
}

/**
 * Places Cloud's extensions in the checkout. It always first removes an existing `<cwd>/.arco-cloud/` (a committed
 * copy must never ship), then for each extension downloads the tarball to a temporary file outside the checkout,
 * checks its sha256, lists it (refusing absolute paths, `..` segments and any entry that is not a plain file or
 * directory), extracts it into `<cwd>/.arco-cloud/<key>/` and writes `config.json` from `config`. Error messages name
 * the key only, never the URL (it is a presigned download link). On failure nothing is left in the checkout.
 */
export async function withExtensions(
  cwd: string,
  extensions: Record<string, Extension>,
  fetchImpl?: typeof fetch,
  log: (line: string) => void = () => {},
): Promise<ExtensionsChild> {
  const root = join(cwd, EXTENSIONS_DIR);
  const cleanup = () => rm(root, { recursive: true, force: true });

  if (await exists(root)) {
    await cleanup();
    log(`Removed an existing ${EXTENSIONS_DIR} directory from the checkout.`);
  }
  const entries = Object.entries(extensions);
  if (entries.length === 0) return { cleanup };

  const download = await mkdtemp(join(tmpdir(), 'arco-ext-dl-'));
  try {
    for (const [key, extension] of entries) {
      if (!EXTENSION_KEY.test(key)) throw new Error('An extension key is not valid');
      const archive = join(download, `${key}.tar.gz`);
      await fetchArchive(key, extension, archive, fetchImpl ?? fetch);
      await refuseUnsafeEntries(key, archive);
      const dir = join(root, key);
      await mkdir(dir, { recursive: true });
      await tar(['-xzf', archive, '-C', dir, '--no-same-owner']);
      await normalizeTree(key, dir);
      await writeFile(join(dir, 'config.json'), JSON.stringify(extension.config), { mode: 0o644 });
      log(`Added the Arco Cloud extension ${key} ${extension.version}.`);
    }
    return { cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  } finally {
    await rm(download, { recursive: true, force: true });
  }
}

async function fetchArchive(key: string, extension: Extension, file: string, fetchImpl: typeof fetch): Promise<void> {
  let body: Buffer;
  try {
    const response = await fetchImpl(extension.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = Buffer.from(await response.arrayBuffer());
  } catch (e) {
    const reason = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timed out' : e instanceof Error ? e.message : String(e);
    throw new Error(`Could not download the ${key} extension: ${reason}`);
  }
  if (createHash('sha256').update(body).digest('hex') !== extension.sha256.toLowerCase()) {
    throw new Error(`The ${key} extension did not match its checksum`);
  }
  await writeFile(file, body, { mode: 0o600 });
}

/** Lists the archive before extracting it: only plain files and directories, all inside the extension directory. */
async function refuseUnsafeEntries(key: string, archive: string): Promise<void> {
  const unsafe = new Error(`The ${key} extension archive has an entry outside its directory or a link`);
  let names: string[];
  let verbose: string[];
  try {
    names = (await tar(['-tzf', archive])).split('\n').filter((l) => l !== '');
    verbose = (await tar(['-tvzf', archive])).split('\n').filter((l) => l !== '');
  } catch {
    throw new Error(`The ${key} extension archive could not be read`);
  }
  // One line per entry in both listings; a name with a newline would break that, so a mismatch is refused too.
  if (names.length !== verbose.length) throw unsafe;
  for (const name of names) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw unsafe;
  }
  // The first character of a verbose line is the entry type: `-` file, `d` directory; `l` symlink, `h` hard link,
  // and anything else (devices, FIFOs) is refused.
  for (const line of verbose) {
    if (line[0] !== '-' && line[0] !== 'd') throw unsafe;
  }
}

/**
 * After extraction, checks again that nothing but files and directories was created, and makes the tree readable
 * by the deploy child (which may run as another user): directories 0755, files at least 0644.
 */
async function normalizeTree(key: string, dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await chmod(path, 0o755);
      await normalizeTree(key, path);
    } else if (entry.isFile()) {
      await chmod(path, ((await lstat(path)).mode & 0o755) | 0o644);
    } else {
      throw new Error(`The ${key} extension archive has an entry outside its directory or a link`);
    }
  }
}

/** The installed multiapi/arco-laravel version from `vendor/composer/installed.json` (Composer 1 or 2); null when absent. */
export function arcoLaravelVersion(cwd: string): string | null {
  let installed: unknown;
  try {
    installed = JSON.parse(readFileSync(join(cwd, 'vendor/composer/installed.json'), 'utf8'));
  } catch {
    return null;
  }
  const packages = Array.isArray(installed) ? installed : isObject(installed) && Array.isArray(installed.packages) ? installed.packages : [];
  for (const p of packages as unknown[]) {
    if (isObject(p) && p.name === 'multiapi/arco-laravel' && isNonEmptyString(p.version)) return p.version;
  }
  return null;
}

/** A Composer development version (`dev-main`, `1.x-dev`): its number says nothing, so it is taken as recent enough. */
export const isDevVersion = (version: string): boolean => version.startsWith('dev-') || version.endsWith('-dev');

/**
 * True when `version` is at least `min`. A leading `v` is ignored, missing parts count as 0 and a pre-release or
 * build suffix is ignored (as for the config layer's Arco check). A dev version satisfies; null or unparseable does not.
 */
export function satisfiesMinVersion(version: string | null, min: string): boolean {
  if (version === null) return false;
  if (isDevVersion(version)) return true;
  const parse = (v: string) => v.replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)?.slice(1).map((n) => Number(n ?? 0));
  const have = parse(version);
  const need = parse(min);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  }
  return true;
}
