---
"eve": patch
---

Fix `eve dev` runtime snapshot decay so stale generations stop accumulating on disk: snapshots staged but never activated and generations superseded more than 24 hours ago now decay down to the active snapshot, pruning sweeps run at dev-server startup, and one unreadable snapshot no longer silently disables a whole prune pass.
