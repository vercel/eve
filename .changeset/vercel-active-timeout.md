---
"eve": patch
---

Vercel sandbox timeouts are now extended while eve runs commands or transfers files, so active work can continue beyond the initial timeout.

The default remains 30 minutes. Renewal ends when the operation finishes or its execution scope closes; idle-stop behavior and detached background jobs are unchanged. Vercel's maximum session duration still applies.
