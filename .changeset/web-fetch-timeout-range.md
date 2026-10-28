---
"eve": patch
---

`web_fetch` now rejects a `timeout` of zero, a negative number, or a non-finite value with `timeout must be a positive number of seconds, up to 120.`, instead of throwing an opaque `RangeError` or aborting the request immediately.
