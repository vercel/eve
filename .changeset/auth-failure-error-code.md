---
"eve": patch
---

A tool call that fails with an `EveError` now reports that error's `code` as its error code on `call.settled` and as `error.type` on the tool span, instead of `ACTION_RESULT_FAILED`. `ConnectionAuthorizationFailedError` is now an `EveError` whose `code` is its `reason` (or `authorization_failed`), so a failed sign-in reports why, such as `token_rejected_after_authorization` or `sign_in_cancelled`.
