---
"eve": minor
---

Add `sessions.end()` and `sessions.prewarm()` to `eve/server` and retire handed-off sessions cleanly when their anchor Vercel deployment has been deleted.

`sessions.end(sessionId, options?)` retires an active or stranded session by ID in process without a request context or channel handle, returning a `Delivery` and throwing `SessionNotActiveError` when inactive. `sessions.prewarm(sessionId)` prepares an idle session to hand off onto the current deployment without starting a model turn. When a handed-off session's initial anchor deployment is deleted on Vercel, both `end()` and `sessionTimeoutMs` preserve sandbox and child-session cleanup on the live deployment, skip the unreadable terminal stream write and channel `session.ended` handlers, and cancel the dead anchor run.

Thanks @xcscxr for #6568 and #4603.
