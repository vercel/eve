---
"eve": patch
---

A session now keeps its tasks and the workflow tool calls its turn waits on in one private record. Session checkpoints move to version 14: a deployment running this release takes over sessions from earlier ones and moves their running work into the new record, and an earlier deployment refuses a version 14 checkpoint, so the session stays where it is.
