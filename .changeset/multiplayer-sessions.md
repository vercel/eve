---
"eve": minor
---

Let anyone in a shared session steer the running turn, and ask the turn's caller before eve uses their identity after someone else has spoken.

A message from another person now joins the running turn instead of waiting for it to end; the turn keeps its caller, and `ctx.session.auth.sender` names who spoke last. While a turn waits on an approval, sign-in, or question, other people's messages wait for it to end and then join. Set `turnPolicy: "queue"` to keep every message waiting for the turn to end.

After someone other than the caller speaks, a call to a user-scoped or `forwardPrincipal` connection, or to a remote agent that forwards the caller, asks the caller first, and only the caller can approve it. In an authored tool, `ctx.getToken()` for a user-scoped provider fails with `ConnectionAuthorizationFailedError` and `reason: "caller_confirmation_required"` until the caller replies. `always()` and `once()` take `{ when: "principal-mismatch" }` (typed `AlwaysApprovalOptions` and `OnceApprovalOptions`) to ask only while someone other than the caller spoke last; set `approval: once({ when: "principal-mismatch" })` in `agent.ts` to prompt instead of refusing. Sessions with one person don't change.
