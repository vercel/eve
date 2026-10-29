---
"eve": minor
---

Move tool-stub permissions from shared authentication types and Vercel OIDC options into eve-channel authentication results.

Use `EveAuthFn` and `EveAuthResult` from `eve/channels/eve` for callbacks that return `allowToolStubs`. Replace granting objects in `vercelOidc({ subjects })` with subject strings, then attach the grant in an eve-channel callback after verifying the caller. Ordinary authenticators remain usable unchanged and do not grant tool replacement.

Request-only permissions are excluded from persisted and forwarded session identities. Tool replacement and stub verification still require an explicit grant on the current request.
