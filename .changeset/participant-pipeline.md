---
"eve": patch
---

A dynamic skill, tool, or model resolver that handles an event its slot never receives now fails the build, as connection, instruction, and subagent resolvers already did. Memory recall now runs after an event's hooks, with the dynamic resolvers, so a hook that cancels the turn from `turn.started` stops recall for a turn that won't call the model.
