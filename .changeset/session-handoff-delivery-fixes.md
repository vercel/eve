---
"eve": patch
---

Fix workflow-tool authorization callbacks and preserve messages accepted while session hooks are being released. Messages buffered during busy execution no longer trigger deployment handoff after the queue drains.
