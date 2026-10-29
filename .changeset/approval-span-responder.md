---
"eve": patch
---

Approval spans now record who approved or denied the call as `agent.approval.responder.type` and `agent.approval.responder.id`, an approved call's tool span records its approver as `agent.tool.approver.type` and `agent.tool.approver.id`, and the `interaction.settled` instrumentation event carries the same `responder`.

An approved call runs as the requester, so until now traces showed only the requester and an audit had to read the session stream to find the approver. The responder's id follows the same rule as the turn's principal ids: it is recorded only when the trace policy records both inputs and outputs and the conversation is public or running in development.
