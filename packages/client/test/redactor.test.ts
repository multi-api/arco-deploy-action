import { describe, expect, it } from 'vitest';
import { Redactor, secretVariants } from '../src/redactor.js';

const secret = 's3cr3t+/=value';
const b64 = Buffer.from(secret).toString('base64');
const forms: Record<string, string> = {
  raw: secret,
  base64: b64,
  'base64 unpadded': b64.replace(/=+$/, ''),
  base64url: b64.replace(/\+/g, '-').replace(/\//g, '_'),
  'base64url unpadded': b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  'url-encoded': encodeURIComponent(secret),
  'json-escaped': JSON.stringify(secret).slice(1, -1),
};

describe('Redactor', () => {
  for (const [name, form] of Object.entries(forms)) {
    it(`masks the ${name} form inside a longer line`, () => {
      const r = new Redactor();
      r.add(secret);
      expect(r.redact(`before ${form} after`)).toBe('before *** after');
    });
  }

  it('masks the json-escaped form of a secret with quotes', () => {
    const r = new Redactor();
    r.add('a"b\\c-secret');
    expect(r.redact('{"k":"a\\"b\\\\c-secret"}')).toBe('{"k":"***"}');
  });

  it('masks each line of a multi-line secret on its own', () => {
    const r = new Redactor();
    r.add('line-one-x\nline-two-y');
    expect(r.redact('got line-one-x here')).toBe('got *** here');
    expect(r.redact('got line-two-y here')).toBe('got *** here');
  });

  it('ignores secrets shorter than 4 characters', () => {
    const r = new Redactor();
    r.add('abc');
    expect(r.redact('abc abc')).toBe('abc abc');
    expect(r.secrets).toEqual([]);
  });

  it('masks the longest variant first', () => {
    const r = new Redactor();
    r.add('token123');
    r.add('token123456');
    expect(r.redact('token123456')).toBe('***');
    expect(r.redact('token123 and token123456')).toBe('*** and ***');
  });

  it('exposes the added secrets', () => {
    const r = new Redactor();
    r.add('abcd1234');
    expect(r.secrets).toEqual(['abcd1234']);
  });
});

describe('secretVariants', () => {
  it('is deduplicated and every variant has at least 4 characters', () => {
    const v = secretVariants('abcd');
    expect(new Set(v).size).toBe(v.length);
    expect(v.every((s) => s.length >= 4)).toBe(true);
    expect(v).toContain('abcd');
  });
});
