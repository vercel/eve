---
"eve": patch
---

Fix `turn.started` dynamic model, tool, skill, and subagent resolvers receiving an empty message snapshot. `ctx.messages` now includes visible conversation history and the incoming message.
