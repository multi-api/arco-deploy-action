# Changelog

## 0.1.11

- `mode: 'remove'`: runs `arco remove --env=<environment> --yes --json --no-wait-interfaces` (with the config layer, without the permissions boundary), streams its steps to the run log like a deploy, and finishes with `result: 'removed'` or `'failed'` (the error key and message on failure).
- The finish payload of a remove carries `notes`: the `remove.resource_kept` resources as `{type, name}` and the `remove.role_kept_for_interfaces` note as `{key, role, region, functions}`, so Cloud can wait for the VPC interfaces and delete the role. `notes` is dropped, like the other optional fields, if Cloud refuses it.
