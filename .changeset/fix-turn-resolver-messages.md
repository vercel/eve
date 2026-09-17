---
"eve": patch
---

Fix `turn.started` dynamic model, tool, skill, and subagent resolvers receiving an empty message snapshot. `ctx.messages` now includes visible conversation history and incoming input, including deferred session-limit turns and authorization resumes, with history projection preserved after memory recall.
