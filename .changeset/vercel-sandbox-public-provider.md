---
"eve": minor
---

`VercelSandbox` now runs on the public `defineSandboxProvider()` API, keeping existing sandbox names, session state, and snapshots. Breaking: a relative `workingDirectory` now resolves from `/workspace`, and `eve/sandbox/vercel` no longer re-exports `Drive`, so import it from `@vercel/sandbox` instead.
