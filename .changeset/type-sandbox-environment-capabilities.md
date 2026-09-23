---
"eve": minor
---

Pass a configured sandbox environment to `ctx.getSandbox(environment)` to preserve its provider-specific session capabilities in the returned eve sandbox handle. The common `SandboxSession` no longer exposes optional `setNetworkPolicy`; use the configured environment when accessing that capability.
