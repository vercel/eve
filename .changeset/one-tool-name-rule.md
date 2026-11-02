---
"eve": minor
---

A dynamic tool no longer replaces a static tool of the same name: the static tool keeps the name and eve logs an error, as it already did for two dynamic tools with the same name.

To change a tool for some sessions only, define it only in a dynamic file that returns the usual version to the other sessions.

Agents whose only tools are dynamic now get the parallel-calls note in their system prompt, and the `$eve.tool_count` span attribute counts the tools offered to the model rather than the tools the agent declares.
