---
"eve": minor
---

Tools and connections now share the `Approval` policy contract; `approvalKey` and `ApprovalContext.approvedTools` are removed. `once()` remembers consent per resolved tool for the session, not per input, and custom policies must return its decision unchanged to reuse or record that consent.
