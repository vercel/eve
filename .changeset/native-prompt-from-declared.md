---
"eve": patch
---

eve now renders each model call's system prompt from the current deployment's agent files instead of storing it with the session.

A session checkpoint no longer carries `agent.system`. A deployment from before this change can't resume a session this one has written.
