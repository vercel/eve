---
"eve": patch
---

Tool `execute` and `approval` callbacks now receive the tool call id: `ToolContext` and `ApprovalContext` carry a `callId` that matches the `callId` on the call's `actions.requested` and `action.result` stream events. Approval-gated tools can use it to derive one record identity that stays stable across proposal, rejection, and execution.
