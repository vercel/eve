---
issue: "Maintainer-approved pre-1.0 auth boundary cleanup; related #5479"
status: implemented
last_updated: 2026-10-29
---

# eve-channel auth permissions

Shared authentication returns identity only. Tool replacement is an eve-channel permission, so its grant lives on eve-channel types.

## Authoring API

- `vercelOidc`, `AuthFn`, and `AuthResult` from `eve/channels/auth` carry identity only; `subjects` takes strings.
- `eveVercelOidc` from `eve/channels/eve` takes the same options, plus `{ subject, allowToolStubs }` entries. It reuses the shared verifier and Bearer challenge.
- `EveAuthFn` / `EveAuthResult` from `eve/channels/eve` type custom callbacks that return `allowToolStubs`.

## Semantics

Unchanged from before: a grant requires an explicit `allowToolStubs: true` on the current request's auth result; subject grants apply only to verified service/runtime principals; the first accepted authenticator wins; the grant is never persisted or forwarded.

## Out of scope

Agent-info access configuration.
