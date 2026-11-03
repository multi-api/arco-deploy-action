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
