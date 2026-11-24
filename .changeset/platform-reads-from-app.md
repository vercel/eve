---
"eve": patch
---

eve now reads every platform fact from the app that the platform module started, including route auth, telemetry, schedules, sandboxes, and workspace agents, instead of falling back to its built-in Vercel declaration.

A process with no eve app and no generated platform module, such as a plain unit test that calls `routeAuth()`, now sees no platform facts: `localDev()` accepts only `eve dev`, `placeholderAuth()` does not throw for `VERCEL_ENV=production`, and OIDC auth does not accept the current Vercel project without claim matchers.
