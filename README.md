# arco-deploy-action

GitHub Action used by [Arco Cloud](https://arco.cloud) to run deployments in your own repository.
Arco Cloud dispatches a workflow; this action:

1. calls Cloud's API (`start`) to exchange a one-time nonce for temporary AWS credentials,
2. runs `<arco> deploy --env=<env> --json` (skipped when `mode: inventory`) with the credentials
   available only to that child process, streaming logs and events to Cloud,
3. runs `<arco> info --env=<env> --resources --json` to report the resource inventory,
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
default `deploy`); `working-directory` (default `.`); `arco-bin` (default empty, see below).

Every `arco` process runs with `ARCO_TELEMETRY_DISABLE=1`: Cloud deploys turn Arco's anonymous telemetry off.

### Arco binary

`<arco>` above is, in order: the `arco-bin` input when non-empty, else the `ARCO_BIN` environment variable when
non-empty, else `vendor/bin/arco` (the Composer-installed Arco of a Laravel app; unchanged default). A value with a
slash is resolved against `working-directory`; a bare name is looked up on `PATH`. Apps without `vendor/` (Go apps,
for instance) install Arco globally and pass `arco-bin: arco`:

```yaml
- run: |
    composer global require multiapi/arco:^0.13
    echo "$(composer global config bin-dir --absolute)" >> "$GITHUB_PATH"
- uses: multi-api/arco-deploy-action@v1
  with:
    # ...
    arco-bin: arco
```

The same value is used for `deploy`, `info` and `--version`. A binary that cannot be started fails the run
(`arco.no_result`); there is no fallback to `vendor/bin/arco`. In `@multiapi/arco-cloud-client` the option is
`DeployOptions.arcoBin` (resolved by `resolveArcoBin(arcoBin, env)` with the same rules, `env` being the child's
base environment).

Requires Arco >= 0.10 (`--json` output). All Arco output parsing lives in `packages/client/src/arco.ts`.

### Client run modes and capabilities

The action itself runs `deploy` and `inventory`. `@multiapi/arco-cloud-client` (used by Arco Cloud's own runner too)
knows four modes (`RUN_MODES`); `deployAndFinish` with any other runs nothing and finishes as
`client.mode_unsupported`:

| Mode | Arco commands | Finish `result` |
|---|---|---|
| `deploy` | `deploy --env=<env> --yes --json`, then `info --resources --json` | `succeeded` / `failed` |
| `inventory` | `info --resources --json` | `succeeded` / `failed` |
| `remove` | `remove --env=<env> --yes --json --no-wait-interfaces` (`--force` only when `start` says so, see below) | `removed` / `failed` |
| `tenants_restore` | `tenants:restore --env=<env> --json` | `succeeded` / `failed` |

`start` sends `capabilities: ["external_dns", "extensions", "tenant_domains"]` and `supports_config_layer: true`.
`tenant_domains` means the client implements Arco Cloud's customer (tenant) domains contract (multiapi/arco 0.25.0
or later); without it Cloud refuses those runs with `409 client_outdated` and issues no credentials:

- **Forced remove.** `--force` deletes the environment's customer domains, so it is appended to `arco remove` if and
  only if the `start` answer has `remove.force === true` (a strict boolean). Nothing else turns it on: not
  `"true"` or `1`, not an environment variable, not the runner's job document, not another mode.
- **`tenants_restore`.** Runs `arco tenants:restore --env=<env> --json` with the config layer, like a remove (no
  build, deploy, DNS profile, permissions boundary or `info`), and finishes `succeeded` for the outcomes
  `restored`, `already_enabled`, `limit_kept` and `nothing_to_restore` (exit code 0), else `failed` with
  `error_code`, `error_message` and `error_params` from the document's `error` (`arco.no_result` when stdout holds no
  document). `restore_outcome` carries Arco's `outcome` when there is one.

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
