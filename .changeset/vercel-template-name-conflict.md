---
"eve": patch
---

Concurrent builds that need the same new Vercel sandbox template no longer fail with a 400 "sandbox with the name already exists" error. The slower build now waits for the other build's template snapshot and uses it.
