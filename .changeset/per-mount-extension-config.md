---
"eve": minor
---

Extension configuration and durable state now belong to each logical mount, so duplicate mounts can use independent config and state. eve rejects handoffs from older deployments instead of migrating them. Finish sessions that hold legacy extension state on their original deployment, or start new sessions on the updated one.
