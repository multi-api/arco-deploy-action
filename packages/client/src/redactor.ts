const MIN_LENGTH = 4;

function encodings(value: string): string[] {
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_');
  const unpadded = (s: string) => s.replace(/=+$/, '');
  return [value, b64, unpadded(b64), b64url, unpadded(b64url), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];
}

/** Every form of `secret` that must be masked: raw, base64 (standard/URL-safe, padded/unpadded), URL-encoded, JSON-escaped, and each line of a multi-line value. */
export function secretVariants(secret: string): string[] {
  const lines = secret.split(/\r?\n/);
  const sources = lines.length > 1 ? [secret, ...lines] : [secret];
  const out = new Set<string>();
  for (const source of sources) {
    if (source.length === 0) continue;
    for (const form of encodings(source)) {
      if (form.length >= MIN_LENGTH) out.add(form);
    }
  }
  return [...out];
}

/** Replaces known secrets, in every encoding, with `***`. Longest variants go first so a secret that contains another is not half-masked. */
export class Redactor {
  private readonly added: string[] = [];
  private variants: string[] = [];

  add(secret: string): void {
    if (typeof secret !== 'string' || secret.length < MIN_LENGTH) return;
    if (!this.added.includes(secret)) this.added.push(secret);
    this.variants = [...new Set([...this.variants, ...secretVariants(secret)])].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    return this.variants.reduce((t, v) => (t.includes(v) ? t.split(v).join('***') : t), text);
  }

  get secrets(): readonly string[] {
    return this.added;
  }
}

/**
 * Applies `redact` to every string leaf and object key of a JSON-like value; numbers, booleans and null are kept as is.
 * Redacting the serialized JSON instead would corrupt it when a secret equals a literal (`true`, `null`) or digits of a number.
 */
export function redactValue<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[redact(key)] = redactValue(item, redact);
    return out as T;
  }
  return value;
}
