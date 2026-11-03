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

Requires Arco >= 0.10 (`--json` output). All Arco output parsing lives in `packages/client/src/arco.ts`.

### Arco Cloud extensions

Cloud's `start` answer can carry `extensions`: a map from a key (`/^[a-z][a-z0-9-]*$/`) to
`{ version, url, sha256, config, min_arco_laravel?, message_outdated? }`. The client treats them as opaque. In
deploy mode, before `arco deploy`, it:

1. fails the run as `extensions.arco_laravel_outdated` when an extension sets `min_arco_laravel` and
   `vendor/composer/installed.json` has an older `multiapi/arco-laravel`, or none (the message is Cloud's
   `message_outdated`, shown as is; a Composer `dev-*` / `*-dev` version counts as recent enough);
2. **always removes `.arco-cloud/` from the checkout** when it exists, even when Cloud sent no extensions (a copy
   committed to the repository must never ship);
3. downloads each tarball to a temporary file outside the checkout, checks its sha256, refuses absolute paths,
   `..` segments and links, extracts it into `.arco-cloud/<key>/` and writes `config` there as `config.json`.
   Any failure finishes the run as `extensions.failed` without deploying;
4. removes `.arco-cloud/` again once the run ends, however it ends.

Arco packages `.arco-cloud/` like any other project file, so an `exclude()` pattern in `arco.php` that matches it
(such as `.*/**`) drops the extensions from the package. `arco info --json` does not expose the effective exclude
patterns, so the client cannot check this: keep `.arco-cloud/` out of your exclude patterns.

## Development

```
npm install       # links the workspaces
npm test          # vitest in both workspaces; uses packages/client/test/fixtures/fake-arco.mjs
npm run typecheck
npm run build     # builds packages/client, then ncc bundles the action into dist/ (commit it)
```

The Cloud protocol client (API, log batching, deploy session) lives in `packages/client` and is published as
`@multiapi/arco-cloud-client`; the action in `src/` is a thin composition of it.

## Releasing `@multiapi/arco-cloud-client`

Bump `packages/client/package.json` `version`, merge, then push a tag `client-v<version>` on `main`. The
`Publish client` workflow stages the release on npm (trusted publishing with provenance); approve it on
npmjs.com (or `npm stage approve <stage-id>`) with 2FA to make it public.
