---
"eve": patch
---

Reject dynamic tool input schemas containing Zod transformations or custom validation that JSON Schema replay would silently discard. Errors now identify the tool and explain how to move runtime validation into its durable executor; opaque Standard Schema validators must provide JSON Schema explicitly.
