---
"eve": patch
---

Fix background subagent calls failing the parent session when typed or wildcard hooks subscribe to subagent events. These hooks now receive the parent session context after workflow step boundaries.
