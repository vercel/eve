---
"eve": patch
---

`web_fetch` now rejects a `timeout` of zero or less as invalid tool input, instead of throwing an opaque `RangeError` or aborting the request immediately.
