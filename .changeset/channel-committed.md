---
"eve": patch
---

A channel can define `committed(line, ctx)`, which runs once for each committed line, after that line's event handlers, with its facts and position. A channel that renders from the session view needs only this handler.
