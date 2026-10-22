---
"eve": patch
---

`DockerSandbox` now runs on the public `defineSandboxProvider()` contract. Container names, recorded session state, and template image references stay the same, so running sessions and prepared images from earlier builds keep working. A few behaviors change: `sandbox.delete()` removes the session's container by its session-derived name, honors the caller's `abortSignal`, and succeeds when the container is already gone; eve normalizes relative paths such as `logs/../out.txt` to `/workspace/out.txt` before they reach the container; and a Docker environment's `prepare` callback is typed with `DockerSandboxSession`.
