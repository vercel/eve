---
"eve": patch
---

`eve build` no longer fails with `Cannot access '<name>' before initialization` while evaluating authored modules whose shared bundle chunks import each other. Compile now keeps top-level evaluation in source order. Thanks @blaesild for reporting this and pinpointing the fix in #5514.
