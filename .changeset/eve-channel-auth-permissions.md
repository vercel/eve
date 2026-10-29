---
"eve": major
---

Tool-stub grants on Vercel OIDC subjects move from `vercelOidc` to the new `eveVercelOidc` helper in `eve/channels/eve`.

`vercelOidc` and `AuthResult` from `eve/channels/auth` now carry identity only. Rename grant-bearing `vercelOidc` calls to `eveVercelOidc`; the options are unchanged. `vercelOidc` now throws when a `subjects` entry is not a string. Type custom callbacks that return `allowToolStubs` as `EveAuthFn` from `eve/channels/eve`.
