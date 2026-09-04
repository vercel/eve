---
"eve": patch
---

Reject `eve add channel/web` before it writes files when the selected agent belongs to a top-level `agents/` workspace. The error directs users to configure a root Next.js app with `withEve({ agents })` instead.
