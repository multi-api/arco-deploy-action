import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  // Test the action against the client's source, not its built output.
  resolve: { alias: { '@multi-api/arco-cloud-client': resolve(__dirname, 'packages/client/src/index.ts') } },
});
