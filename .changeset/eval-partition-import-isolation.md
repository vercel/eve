---
"eve": patch
---

`eve eval <id>` now constrains discovery to files whose path-derived id can match the requested filter before importing them, so a filtered run never loads eval modules outside the selected partition. Previously every `*.eval.ts` module was imported and only then filtered, letting a held-out module run its initialization side effects during a tuning run (and vice versa).
