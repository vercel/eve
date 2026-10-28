---
"eve": patch
---

A connection tool call no longer fails with `Instance type "null" is invalid` when the model omits an argument whose schema declares a `null` default it does not allow, such as Pydantic's `{ "type": "string", "default": null }` for `x: str = None`. eve fills schema defaults once, when the call runs, instead of filling them before approval and rejecting them on the second check.
