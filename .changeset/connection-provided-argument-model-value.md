---
"eve": patch
---

A connection tool call no longer fails with `Unrecognized key` when the model sends a key the connection supplies through `toolCall.providedArguments`. eve drops the model's value and the provided value is used, as documented.
