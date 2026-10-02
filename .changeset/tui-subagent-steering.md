---
"eve": patch
---

The dev TUI no longer shows a follow-up message to a working subagent as a second subagent: it reads `Message subagent` in the transcript, the task panel keeps one entry, and the task ends with a single line. Parallel `agent` tasks are now named `subagent:2` instead of `subagent(subagent:2)`, and sibling tasks in the panel get a blank row between them when there is room.
