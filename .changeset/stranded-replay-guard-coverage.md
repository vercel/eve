---
"eve": patch
---

On self-hosted Workflow Worlds, an eve upgrade no longer replays a legacy session or a connection event subscription that the earlier eve version started.

Such runs used to replay against renamed steps and fail with a replay divergence. Legacy sessions are now parked like other sessions, and connection event subscriptions are retired with a cancel reason, so the agent must watch those events again. Session timeouts and connection event deliveries still run after an upgrade, because they start fresh on the new version.
