import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCommand } from '../src/index.js';

let pidFile: string | null = null;
afterEach(() => {
  if (!pidFile) return;
  try {
    // The leftover sleeper is in its own process group (spawned detached): kill the group.
    process.kill(-Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL');
  } catch {
    // already gone
  }
  pidFile = null;
});

describe('runCommand settleAfterExitMs', () => {
  it('resolves shortly after exit although a background process holds stdout open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arco-settle-'));
    pidFile = join(dir, 'pid');
    const lines: string[] = [];
    const started = Date.now();
    // The sleeper inherits stdout; the shell (main process) exits at once. $$ is the group leader's pid (detached spawn).
    const result = await runCommand('bash', ['-c', `echo $$ > "${pidFile}"; echo hi; sleep 30 & exit 0`], {
      cwd: dir,
      env: process.env,
      onStdoutLine: (l) => lines.push(l),
      settleAfterExitMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(['hi']);
  });
});
