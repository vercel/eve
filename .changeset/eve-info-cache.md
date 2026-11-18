---
"eve": minor
---

`eve info` reuses its last successful compile when nothing it depends on changed, so a repeat run takes about 0.3 seconds regardless of agent size instead of recompiling, and `eve info --fresh` forces a recompile.

The cache is keyed on the agent directory, every module the compile bundled, package manifests and lockfiles, the eve version, and the environment variables those modules read by literal name. A compile whose modules read the environment dynamically, that failed, or that ran without the AI Gateway model catalog is never reused. `eve dev` and `eve build` always compile.
