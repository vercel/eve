---
"eve": minor
---

Add `ctx.sandbox.delete()` for permanently deleting the current session sandbox and reprovisioning it on the next access. Docker handles stay bound to one physical container, and sandbox `onSession` callbacks now receive session metadata through `ctx` while using `use()` for sandbox access.
