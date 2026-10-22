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
