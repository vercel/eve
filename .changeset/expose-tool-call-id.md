---
"eve": patch
---

`ToolContext` and `ApprovalContext` now expose `callId`, the tool call id carried by the call's stream events, so approval-gated tools can key records to one identity across proposal, rejection, and execution.
