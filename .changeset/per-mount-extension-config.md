---
"eve": minor
---

Extension configuration and durable state now belong to each logical mount, so duplicate mounts can use independent config and state. Session handoffs across this upgrade boundary are rejected in both directions, including for agents without extensions; keep each session's owning deployment available until it finishes, or start a new session on the deployment you want to use.
