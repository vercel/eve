---
"eve": patch
---

Remove the `task_update` tool and its child-to-parent progress callbacks; use the child session's stream to follow progress. Successful background task results now reach the parent together after their full cohort settles, while user input, failures, and cancellation remain responsive.
