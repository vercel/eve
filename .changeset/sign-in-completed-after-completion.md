---
"eve": patch
---

A call a sign-in stopped now waits in its step and runs itself once the sign-in calls back, instead of the model being asked again. `authorization.completed` is reported by that call's outcome, just before its `action.result`: `authorized` when the call returns, `failed` (with the error's `reason`, such as `access_denied`) when it throws. Steering a held turn fails the waiting call and declines its sign-in, and cancel stops it with the turn. A turn needing a sign-in now makes one model call fewer. A session already waiting on a sign-in when this ships keeps reporting `authorized` when its callback arrives.
