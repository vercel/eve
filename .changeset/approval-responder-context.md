---
"eve": patch
---

Approved `defineTool` calls can read who approved them: `ctx.approval.responder` is the approver and `ctx.approval.responder.getToken(provider)` resolves their token, while the call still runs as the requester.
