---
"eve": patch
---

In the local `eve dev` terminal UI, a root request targeting an unavailable Vercel Connect connection now starts project linking or login on first use. After recovery, eve retries the original request without showing an intermediate authorization failure.
