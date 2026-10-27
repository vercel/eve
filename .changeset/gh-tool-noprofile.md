---
"eve": patch
---

Harden the brokered `gh` tool: its commands now run in a shell that skips profile and rc files, invoke `/usr/bin/git` instead of resolving `git` through `PATH`, and use a fresh GitHub CLI data directory per call so extensions installed earlier do not run under the credential lease. `sandbox.run()` and `sandbox.spawn()` accept `loginShell: false` for the same purpose, and custom providers receive `loginShell` in `spawn()`.
