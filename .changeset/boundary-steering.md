---
"eve": patch
---

Steering a running turn or background subagent now applies at the next committed step boundary without cancelling in-flight model or tool work, preserves the turn's identity and usage, and keeps background task notifications out of user steering so cohort batching is retained. Input that arrives after the model has produced its answer starts a new turn; continued subagent turns forward HITL to their current caller, nested agents receive task-owned answers during runtime waits, overlapping stream boundaries no longer end follow-up output early, and cancelled turns no longer wait on workflow tool results.
