---
"eve": patch
---

`eve dev` now runs its workers through env-runner's `RunnerManager`, and every eve build resolves authored source and its tsconfig the same way.

The host build, authored module bundles, and the workflow driver all read the authored package's own `tsconfig.json` or `jsconfig.json`. The workflow driver no longer searches parent directories for one, and an app nested in a package without its own `package.json` now uses that package's tsconfig in the host build too.
