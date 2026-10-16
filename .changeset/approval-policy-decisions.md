---
"eve": minor
---

`once()` accepts an optional `key` to remember approvals per input; `approvalKey` and `ApprovalContext.approvedTools` are removed, and tool approval types merge into `Approval`. Policies keep their existing return values, share validation, and record whether a policy or a remembered approval cleared a call.
