---
"eve": patch
---

eve now renders each model call's system prompt from the current deployment's agent files instead of storing it with the session.

Session checkpoints move to version 19, without `agent.system`. A deployment from before this change refuses to take over a session this one wrote, so the session stays on the deployment that wrote it, such as after a rollback.
