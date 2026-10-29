import { chmod, chown, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The Arco Cloud config layer: the managed resources Cloud adds to the project's arco.php (Arco 0.13+). */
export type ConfigLayer = Record<string, unknown>;

/** The first Arco that reads ARCO_CONFIG_LAYER; an older one ignores it and would deploy without the layer. */
export const CONFIG_LAYER_MIN_ARCO = '0.13.0';

/**
 * Reads `config` from a start answer. Absent (older Cloud) or null (no managed resources) means null;
 * anything but a JSON object throws.
 */
export function parseConfigLayer(answer: unknown, path = 'start'): ConfigLayer | null {
  const { config } = (answer ?? {}) as Record<string, unknown>;
  if (config === undefined || config === null) return null;
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error(`Arco Cloud ${path} answer was malformed (config)`);
  return config as ConfigLayer;
}

/** True when `version` (x.y.z, any suffix ignored) is at least CONFIG_LAYER_MIN_ARCO. */
export function supportsConfigLayer(version: string | null): boolean {
  const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!parts) return false;
  const min = CONFIG_LAYER_MIN_ARCO.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== min[i]!) return parts[i]! > min[i]!;
  }
  return true;
}

export interface ConfigLayerChild {
  env: NodeJS.ProcessEnv;
  /** Removes the layer file; safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Writes the layer to a 0600 JSON file in a fresh temporary directory and sets ARCO_CONFIG_LAYER to it. With no
 * layer, env comes back unchanged. `owner` hands the file to the child's uid/gid when it runs as another user.
 */
export async function withConfigLayer(
  env: NodeJS.ProcessEnv,
  layer: ConfigLayer | null,
  dir?: string,
  owner: { uid?: number | null; gid?: number | null } | null = {},
): Promise<ConfigLayerChild> {
  if (layer == null) return { env: { ...env }, cleanup: async () => {} };

  const tmp = await mkdtemp(join(dir ?? tmpdir(), 'arco-layer-'));
  const cleanup = () => rm(tmp, { recursive: true, force: true });
  try {
    const file = join(tmp, 'config-layer.json');
    await writeFile(file, JSON.stringify(layer), { mode: 0o600 });
    await chmod(file, 0o600);
    if (owner?.uid != null || owner?.gid != null) {
      const uid = owner?.uid ?? -1;
      const gid = owner?.gid ?? -1;
      await chown(tmp, uid, gid);
      await chown(file, uid, gid);
    }
    return { env: { ...env, ARCO_CONFIG_LAYER: file }, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
