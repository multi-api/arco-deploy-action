# arco-deploy-action

GitHub Action used by [Arco Cloud](https://arco.cloud) to run deployments in your own repository.
Arco Cloud dispatches a workflow; this action:

1. calls Cloud's API (`start`) to exchange a one-time nonce for temporary AWS credentials,
2. runs `vendor/bin/arco deploy --env=<env> --json` (skipped when `mode: inventory`) with the credentials
   available only to that child process, streaming logs and events to Cloud,
3. runs `vendor/bin/arco info --env=<env> --resources --json` to report the resource inventory,
4. reports the result (`finish`) and exits non-zero when the deployment failed.

Cloud generates the workflow file for you; you normally never write this by hand.

```yaml
- uses: multi-api/arco-deploy-action@v1
  with:
    token: ${{ inputs.token }}
    api-url: ${{ inputs.api_url }}
    environment: production
    deployment_id: ${{ inputs.deployment_id }}
    nonce: ${{ inputs.nonce }}
```

Inputs: `token`, `api-url`, `environment`, `deployment_id`, `nonce` (required); `mode` (`deploy` | `inventory`,
default `deploy`); `working-directory` (default `.`).

Requires Arco >= 0.10 (`--json` output). All Arco output parsing lives in `src/arco.ts`.

## Development

```
npm install       # links the workspaces
npm test          # vitest in both workspaces; uses packages/client/test/fixtures/fake-arco.mjs
npm run typecheck
npm run build     # builds packages/client, then ncc bundles the action into dist/ (commit it)
```

The Cloud protocol client (API, log batching, deploy session) lives in `packages/client` and is published as
`@multi-api/arco-cloud-client`; the action in `src/` is a thin composition of it.
