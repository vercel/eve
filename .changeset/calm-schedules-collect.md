---
"eve": minor
---

Add experimental `defineDynamicSchedules` with direct operation tools, optional `preparePayload` creation preparation, top-level per-operation approval, and creator-bound execution. Create approval receives prepared data and rejects changed results before writing; `ctx.session.schedule` exposes scheduled-turn provenance without auth attributes.
