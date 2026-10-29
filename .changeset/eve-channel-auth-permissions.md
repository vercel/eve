---
"eve": minor
---

Move tool-stub permissions to eve-channel authentication with `eveVercelOidc` for declarative Vercel OIDC grants.

Rename grant-bearing `vercelOidc` calls to `eveVercelOidc` from `eve/channels/eve`, keeping their subject declarations unchanged. Use `EveVercelOidcOptions` for named options. The helper uses the shared verifier, declares Bearer challenges automatically, and grants tool replacement only to verified service/runtime callers matching an explicitly granting subject entry, never to users. Plain subject strings and implicit current-project acceptance do not grant permission.

Generic `vercelOidc` remains identity-only and accepts subject strings only. For custom callbacks returning `allowToolStubs`, use `EveAuthFn` and `EveAuthResult` from `eve/channels/eve` instead of the shared auth types. Identity-only authenticators remain usable unchanged.

The auth walk still stops at the first successful result without merging grants across authenticators. Request-only permissions are excluded from persisted and forwarded session identities. Stubbed session creation and stub verification still require an explicit grant on the current request.
