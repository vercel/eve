---
"eve": patch
---

`eve init apps/my-agent` now creates missing parent directories such as `apps/` instead of failing with `ENOENT` from `mkdtemp`. Thanks @otakusboy for reporting this in #5422.
