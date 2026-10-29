import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfigLayer, supportsConfigLayer, withConfigLayer } from '../src/index.js';

describe('parseConfigLayer', () => {
  it('is null when config is absent or null', () => {
    expect(parseConfigLayer({})).toBeNull();
    expect(parseConfigLayer({ config: null })).toBeNull();
  });

  it('returns an object as is', () => {
    expect(parseConfigLayer({ config: { schema: 1 } })).toEqual({ schema: 1 });
  });

  it.each([['string', '{}'], ['array', []], ['number', 1]])('throws for a %s, naming the field only', (_, config) => {
    expect(() => parseConfigLayer({ config }, 'start')).toThrow('Arco Cloud start answer was malformed (config)');
  });
});

describe('supportsConfigLayer', () => {
  it.each([
    ['0.13.0', true],
    ['0.13.2', true],
    ['0.14.0', true],
    ['1.0.0', true],
    ['0.13.0-beta.1', true],
    ['0.12.9', false],
    ['0.9.20', false],
    [null, false],
    ['dev-main', false],
  ])('%s -> %s', (version, expected) => {
    expect(supportsConfigLayer(version)).toBe(expected);
  });
});

describe('withConfigLayer', () => {
  it('leaves env unchanged without a layer', async () => {
    const child = await withConfigLayer({ A: '1' }, null);
    expect(child.env).toEqual({ A: '1' });
    await child.cleanup();
  });

  it('writes a 0600 JSON file, sets ARCO_CONFIG_LAYER, and cleanup removes it (twice is fine)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arco-layer-test-'));
    const child = await withConfigLayer({ A: '1' }, { schema: 1, app: 'shop' }, dir);
    const file = child.env.ARCO_CONFIG_LAYER!;
    expect(child.env.A).toBe('1');
    expect(file.startsWith(dir)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: 1, app: 'shop' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await child.cleanup();
    await child.cleanup();
    expect(existsSync(file)).toBe(false);
  });

  it('throws when the directory cannot be created', async () => {
    await expect(withConfigLayer({}, { schema: 1 }, '/nonexistent/arco')).rejects.toThrow();
  });
});
