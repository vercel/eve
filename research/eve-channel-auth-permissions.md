---
issue: "Maintainer-approved pre-1.0 auth boundary cleanup; related #5479"
status: implemented
last_updated: 2026-10-29
---

# eve-channel auth permissions

Shared authentication returns identity only. Tool replacement and agent-info access are eve-channel permissions, so their grants live on eve-channel types.

## Authoring API

- `vercelOidc`, `AuthFn`, and `AuthResult` from `eve/channels/auth` carry identity only; `subjects` takes strings and `vercelOidc` throws on any other entry.
- `eveVercelOidc` from `eve/channels/eve` takes the same options, plus `{ subject, allowToolStubs }` entries. It reuses the shared verifier and Bearer challenge.
- `EveAuthFn` / `EveAuthResult` from `eve/channels/eve` type custom callbacks that return `allowToolStubs` or `allowAgentInfo`. `eveVercelOidc` subject entries carry no `allowAgentInfo`, since verified service and runtime callers already read agent info.

## Semantics

Unchanged from before: a grant requires an explicit `allowToolStubs: true` on the current request's auth result; subject grants apply only to verified service/runtime principals; the first accepted authenticator wins; the grant is never persisted or forwarded.

`allowAgentInfo` on the current request's auth result decides `GET /eve/v1/info`: `true` allows, `false` denies even operators, and omitted serves `service` and `runtime` principals plus callers `localDev()` admits when the channel's auth includes it. Like `allowToolStubs`, it is never persisted or forwarded.

## Out of scope

Roles or other permission frameworks beyond these two request-local flags.
