---
"eve": minor
---

The eve HTTP channel now rejects unknown top-level fields on session creation, message, and control requests with HTTP 400 and a list of accepted fields. Correct unsupported options and misspellings instead of relying on them being ignored.
