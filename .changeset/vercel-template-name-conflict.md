---
"eve": patch
---

Concurrent builds that need the same new Vercel sandbox template no longer fail with a 400 "sandbox with the name already exists" error. Each build now prepares its template in a private, non-persistent sandbox and records the finished snapshot under the shared template name only after the snapshot exists, so a build that fails, is killed, or times out never leaves half-prepared work where another build would reuse it.
