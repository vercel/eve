---
"eve": minor
---

Approved tool calls can read who approved them. While an approved call runs, `ctx.approval.responder` is the approver's principal and `ctx.approval.getToken()` resolves the approver's token for an inline provider. The call itself still runs as the requester: `ctx.session.auth.current` and `ctx.getToken()` stay the requester's. `ctx.approval` is absent for calls that needed no approval.
