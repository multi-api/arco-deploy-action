# Changelog

## 0.2.0

Arco Cloud customer (tenant) domains, for multiapi/arco 0.25.0 or later.

- `start` advertises the capability `tenant_domains` (next to `external_dns` and `extensions`). Cloud refuses a forced Remove or a `tenants_restore` run (`409 client_outdated`, no credentials) to a client without it.
- Forced remove: `arco remove` gets `--force` if and only if the `start` answer has `remove.force === true` (strict boolean; `"true"`, `1` or an absent key never add it, nor does anything in the environment or another mode). `StartResponse.remove` is typed; `isForcedRemove(started)` is exported.
- `mode: 'tenants_restore'`: runs `arco tenants:restore --env=<environment> --json` (with the config layer, as a remove; no deploy, DNS profile, boundary or `info`), shows its document in the run log and finishes `succeeded` for the outcomes `restored`, `already_enabled`, `limit_kept` and `nothing_to_restore` with exit code 0, else `failed` with `error_code`, `error_message` and `error_params` from the document's `error` (`arco.no_result` when stdout holds no document). The finish carries `restore_outcome` when Arco reported one; it is dropped, like the other optional fields, if Cloud refuses it.
- `RUN_MODES`, `RunMode` and `isRunMode` are exported; `deployAndFinish` with a mode it does not know runs nothing and finishes the run as `client.mode_unsupported`.

## 0.1.11

- `mode: 'remove'`: runs `arco remove --env=<environment> --yes --json --no-wait-interfaces` (with the config layer, without the permissions boundary), streams its steps to the run log like a deploy, and finishes with `result: 'removed'` or `'failed'` (the error key and message on failure).
- The finish payload of a remove carries `notes`: the `remove.resource_kept` resources as `{type, name}` and the `remove.role_kept_for_interfaces` note as `{key, role, region, functions}`, so Cloud can wait for the VPC interfaces and delete the role. `notes` is dropped, like the other optional fields, if Cloud refuses it.
