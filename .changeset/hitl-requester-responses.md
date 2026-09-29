---
"eve": patch
---

Approval response policies now receive `request.principal`, the person whose turn requested the call, so a policy can let only that person approve it in a shared conversation. It is `null` when the caller was unauthenticated or anonymous.
