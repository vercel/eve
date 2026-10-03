---
"eve": minor
---

Split self-modification into separate `eve/self-modification/local` and `eve/self-modification/deployed` mounts, so `eve dev` no longer loads deployed sandbox dependencies. `eve/self-modification` remains an alias for the local mount and now rejects the `deployed` option; move that configuration to its own mount, for example `agent/extensions/self-modification-deployed/extension.ts`, with the former `deployed` fields at the top level.
