---
"eve": patch
---

Fixed Vercel sandbox network-policy updates failing with `410 sandbox_stopped` after the sandbox timed out. `setNetworkPolicy()` now resumes the same sandbox and retries the live update once.
