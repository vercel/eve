---
"eve": patch
---

Statically authored connections now keep an object-form `approval` with `request` and `response` policies.

Previously only the function form was kept, so a static connection written with the object form ran every tool call without approval. A malformed `approval` now fails when the connection resolves instead of being ignored.
