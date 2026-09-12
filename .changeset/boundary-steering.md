---
"eve": patch
---

Steering a running turn or background subagent now applies at the next committed step boundary without cancelling in-flight model or tool work, preserves the turn's identity and usage, and keeps background task notifications out of user steering so cohort batching is retained. Also fixes a race that could leave a cancelled turn waiting on a workflow tool result.
