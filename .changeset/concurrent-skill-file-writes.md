---
"eve": patch
---

Dynamic skills with supporting files no longer delay the first model call by seconds. eve now writes a skill's files to the sandbox concurrently, so a 25-file skill syncs in under a second instead of about five.
