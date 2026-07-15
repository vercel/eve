---
"eve": patch
---

Added `POST /eve/v1/session/:sessionId/cancel` to the eve HTTP channel for cancelling a session's in-flight turn. The optional `{ turnId }` body scopes the cancel to the turn the caller observed; the response reports `"cancelling"` (delivered — the turn settles as `turn.cancelled` followed by `session.waiting`) or the benign `"no_active_turn"` when there is nothing to cancel.
