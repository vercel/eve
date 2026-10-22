---
"eve": minor
---

**Breaking for `eve/sandbox/vercel`.** `VercelSandbox` now runs on the public `defineSandboxProvider()` API. Sandbox names, recorded session state, template keys, and prepared snapshot IDs are unchanged, so running sessions and earlier builds keep working. Two things change:

- A relative `workingDirectory` passed to `run()` or `spawn()` now resolves from `/workspace`, as it already does with Docker and just-bash. Vercel previously passed it to the Sandbox SDK unchanged.
- `eve/sandbox/vercel` no longer re-exports `Drive`. Import it from `@vercel/sandbox` and pass it in `mounts` as before, or pass a `{ drive, mode }` reference to a Drive by name. `VercelSandboxMount`, `VercelSandboxMounts`, and `VercelSandboxMountMode` are now eve-owned types.

The `prepare` callback of `VercelSandbox.environment()` now receives a `VercelSandboxSession`, including `name` and `setNetworkPolicy()`.
