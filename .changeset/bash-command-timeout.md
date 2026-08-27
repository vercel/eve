---
"eve": patch
---

Cap every built-in `bash` foreground wait at 30 seconds and yield earlier near a Vercel Function deadline. Yielded Vercel Sandbox commands now deliver their exit code and bounded output as a new queued session message; an accepted kill suppresses a pending completion delivery.
