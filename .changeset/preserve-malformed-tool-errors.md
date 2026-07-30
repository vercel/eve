---
"eve": patch
---

Malformed raw tool arguments now preserve the original JSON syntax error and return it to the model as a failed tool result instead of reporting a misleading serialization error.
