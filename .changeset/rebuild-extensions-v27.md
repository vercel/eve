---
"eve": minor
---

Hook, channel, and schedule extensions must be rebuilt with this eve: those contracts drop their earlier epochs, since v27 removes the v26 event keys, metadata, and handler payloads they used. Tool, dynamic tool, connection, dynamic skill, dynamic instruction, and subagent extensions keep working.
