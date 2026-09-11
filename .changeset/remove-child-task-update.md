---
"eve": patch
---

Remove the `task_update` tool and its child-to-parent progress callbacks; use the child session's stream to follow progress. Successful results from overlapping background tasks now reach the parent together across launch turns, after child settlement updates usage and handles; user input, failures, and cancellation remain responsive.
