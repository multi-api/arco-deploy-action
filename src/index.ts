import * as core from '@actions/core';
import { run } from './run';

async function main(): Promise<void> {
  const token = core.getInput('token', { required: true });
  core.setSecret(token);
  const nonce = core.getInput('nonce', { required: true });
  core.setSecret(nonce);

  const mode = core.getInput('mode') || 'deploy';
  if (mode !== 'deploy' && mode !== 'inventory') throw new Error(`Unknown mode "${mode}" (expected deploy or inventory)`);

  const exitCode = await run({
    token,
    nonce,
    apiUrl: core.getInput('api-url', { required: true }),
    environment: core.getInput('environment', { required: true }),
    deploymentId: core.getInput('deployment_id', { required: true }),
    mode,
    workingDirectory: core.getInput('working-directory') || '.',
    mask: (s) => core.setSecret(s),
    warn: (m) => core.warning(m),
  });
  if (exitCode !== 0) core.setFailed(`Arco deploy failed (exit code ${exitCode})`);
}

main().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)));
