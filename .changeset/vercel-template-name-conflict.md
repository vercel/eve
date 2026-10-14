---
"eve": patch
---

Concurrent builds that need the same new Vercel sandbox template no longer fail with a 400 "sandbox with the name already exists" error, and no longer prepare and snapshot the same template twice. Only the build that created the template prepares it; any other build waits for that build's snapshot and uses it.
