---
"eve": patch
---

Prevent Nitro/Rolldown dev watchers from subscribing to immutable dev-runtime snapshots; Eve's authored-source watcher already owns rebuilds and explicitly reloads Nitro when runtime wiring changes.
