---
"eve": minor
---

Add `delete()` to the runtime sandbox handle for permanently deleting the current session sandbox and reprovisioning it on the next access. Docker handles stay bound to one physical container, and sandbox `onSession` callbacks now receive session metadata through `ctx` while using `use()` for sandbox access.
