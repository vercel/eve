---
"eve": patch
---

`defineRemoteAgent` now accepts a function for `url`, resolved at runtime instead of baked at compile time. Return a `string` (or `Promise<string>`) from `() => process.env.MY_SERVICE_URL` to target an endpoint supplied by a runtime env var, known only once the deployment runs.
