---
"eve": patch
---

`eve dev` now rebuilds its host when a connection turns on events or an extension mount changes the package export it imports.

Before, those edits reused the running host, so a connection's event receiver route or the new mount stayed missing until `eve dev` restarted.
