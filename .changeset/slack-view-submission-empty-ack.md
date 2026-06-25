---
"eve": patch
---

Acknowledge Slack `view_submission` (the free-form HITL input modal) with an empty 200 body instead of `"ok"`. A non-empty body is invalid for a view submission, so Slack showed a generic error and left the modal open even though the submitted value was accepted and delivered. Returning an empty body dismisses the modal. Block Actions acks are unchanged (they ignore the response body).
