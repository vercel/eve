---
"eve": patch
---

`DockerSandbox` now runs on the public `defineSandboxProvider()` contract. Container names, recorded session state, and template image references stay the same, so running sessions and prepared images from earlier builds keep working. Two behaviors change: `sandbox.delete()` removes the session's container by name and succeeds when the container is already gone, and eve normalizes relative paths such as `logs/../out.txt` to `/workspace/out.txt` before they reach the container.
