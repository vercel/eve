---
"eve": patch
---

Keep dynamic tool callbacks isolated by session, lifecycle scope, and resolver. Replaying a tool now retains its own implementation when another session or scope registers the same tool name.
