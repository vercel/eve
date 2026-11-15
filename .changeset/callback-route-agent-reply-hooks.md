---
"eve": patch
---

The `/eve/v1/callback/:token` route now resumes only a call that waits for a remote agent's reply, so a request to it that guesses a token can't resume a hook your code created with `createHook()` or any other eve hook.

eve now names each reply hook with a random token under the reserved `eve:reply:v1:` prefix, and the route answers `404` with `code: "CALLBACK_NOT_PENDING"` for any other token. The token comes from a step, so it can't be computed from the run that waits on it. Don't start a `createHook()` token with `eve:`.

A remote agent call that an earlier eve release started doesn't receive its reply once this release serves the parent's callback route: the remote stops retrying after a few seconds, and the call never gets that reply. Let those calls finish before you upgrade, or run them again afterward.
