---
"eve": patch
---

Update eve's bundled Workflow SDK to fix leaked stream-writer WebSockets when a released writable is left open. Public writable aborts now also dispose their underlying session.
