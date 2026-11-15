---
"eve": patch
---

The `/eve/v1/callback/:token` route now resumes only a call that waits for a remote agent's reply, so a request that guesses a token can't resume a hook your code created with `createHook()` or any other eve hook.

A remote agent call started on an earlier eve release doesn't receive its reply after the parent's production deployment moves to this release. Let those calls finish before you upgrade, or run them again afterward.
