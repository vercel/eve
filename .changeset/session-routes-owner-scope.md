---
"eve": minor
---

Let an eve-channel authenticator return `sessionAccess` beside `allowToolStubs` and `allowAgentInfo` to scope the session routes per caller: `"owner"` limits a caller to the sessions its identity created and answers any other session with the same `404` as an unknown id, `"any"` (the default) keeps today's behaviour, and a function receiving `{ sessionId, isOwner, auth, request }` decides per session.

A session created with no auth now has the same owner as an anonymous caller.
