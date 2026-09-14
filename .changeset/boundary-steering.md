---
"eve": patch
---

Steering a running turn or background subagent now applies at the next committed step boundary without cancelling in-flight model or tool work, preserves the turn's identity and usage, and keeps background task notifications out of user steering so cohort batching is retained. Input that arrives after the model has produced its answer starts a new turn. Also fixes a race that could leave a cancelled turn waiting on a workflow tool result.
