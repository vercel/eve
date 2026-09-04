---
"eve": patch
---

Avoid decrypting hook metadata when resolving session ownership or waiting for inbox registration and release. This removes unnecessary encryption-key work from channel routing, subagent startup, and session reset.
