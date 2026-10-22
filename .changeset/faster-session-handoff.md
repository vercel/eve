---
"eve": patch
---

Validate idle session state inside the workflow before starting a deployment handoff, avoiding unnecessary successor starts when durable work is still pending. Preserve inbox ownership and the original session stream throughout the move.
