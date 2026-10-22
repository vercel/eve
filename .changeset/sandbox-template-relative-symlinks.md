---
"eve": patch
---

Relative symlinks in an agent's `sandbox/workspace/` files, in skill packages, and in sandbox templates now stay relative in build output and in each sandbox session. Before, eve rewrote them as absolute host paths: `just-bash` sessions rejected them with `EACCES ... resolves outside sandbox`, and they did not resolve inside Docker, microsandbox, or remote sandboxes.
