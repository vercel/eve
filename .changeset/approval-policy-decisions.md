---
"eve": minor
---

Tools and connections now share the `Approval` policy contract; `approvalKey` and `ApprovalContext.approvedTools` are removed. `once()` remembers the latest approval or denial per resolved tool for the session; custom policies must return its decision unchanged to reuse or record consent.
