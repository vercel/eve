---
"eve": minor
---

Store message and reasoning appends as deltas instead of repeating cumulative text. Message, reasoning, and streamed tool-input append events now carry `startsBlock` so consumers can replace abandoned partial output when a retry starts a new block.

Extensions built against the previous dynamic-tool, channel, schedule, subagent, connection, hook, dynamic-skill, or dynamic-instructions capability contracts must be rebuilt and republished with this release.
