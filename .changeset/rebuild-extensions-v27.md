---
"eve": minor
---

Rebuild hook, channel, and schedule extensions for the v27 event contract, and rebuild tool extensions that require capability epoch 88 because `toolResultFrom` now accepts a settled call row instead of a v26 action result. Other previously supported tool, dynamic tool, connection, dynamic skill, dynamic instruction, and subagent epochs remain supported.
