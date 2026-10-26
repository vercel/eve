---
"eve": minor
---

Remote agents no longer serve callers on eve 0.66 through 0.68 (remote agent protocol 1), and callers no longer accept remote agents on those releases. Calls in either direction now fail at start with `REMOTE_AGENT_PROTOCOL_MISMATCH`; upgrade both deployments to the same eve release. The `/eve/v1/task-input/:token` route is gone. It accepted unauthenticated answers that settled approvals and added turn input as the session's current user.
