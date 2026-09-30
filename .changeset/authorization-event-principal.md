---
"eve": patch
---

`authorization.required` and `authorization.completed` events now include `principalId`, the session principal who started the sign-in, using the same value as `responderPrincipalId` on approval events. Candidate sign-in events also now include their `attemptId`.
