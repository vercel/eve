---
"eve": patch
---

A tool call that fails because authorization failed now reports the failure's reason, such as `token_rejected_after_authorization` or `sign_in_cancelled`, as its error code on `call.settled` and as `error.type` on the tool span, instead of `ACTION_RESULT_FAILED`.
