---
"eve": minor
---

Store message and reasoning appends as plain deltas instead of repeating cumulative text. Streamed tool-input appends now use the same delta-only shape.

Empty tool-input start markers no longer emit an append event; the first append contains actual input text.

Extensions built against the previous dynamic-tool, channel, schedule, subagent, connection, hook, dynamic-skill, or dynamic-instructions capability contracts must be rebuilt and republished with this release.
