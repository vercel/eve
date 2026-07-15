---
"eve": patch
---

Added `POST /eve/v1/session/:sessionId/cancel` to the eve HTTP channel for requesting cancellation of an in-flight turn. The optional `{ turnId }` body limits the request to the turn the caller observed; the response reports `"accepted"` when a cancellation hook accepts it or the benign `"no_active_turn"` when no resumable target exists.
