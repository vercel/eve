---
"eve": minor
---

Every `turn.started` now carries `runtime`, the eve instance that runs the turn, and `RuntimeIdentity.build` adds `deploymentId` from `VERCEL_DEPLOYMENT_ID`, so a reader can tell which deployment, commit, and eve version ran each turn after a session moves between deployments.

Before, only `session.started` recorded the runtime, so every later turn read as the session's first deployment, and two deployments of one commit recorded identical identities. Both fields are optional; readers that don't know them ignore them, and the projection's turn rows don't keep `runtime`.

Thanks @zackleman for reporting this in #5930.
