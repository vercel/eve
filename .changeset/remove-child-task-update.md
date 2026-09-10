---
"eve": patch
---

Remove the `task_update` tool and its child-to-parent progress callbacks. Background subagents still report terminal outcomes to their parent; use the child session's stream to follow progress.
