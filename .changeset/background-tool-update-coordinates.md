---
"eve": patch
---

Allow in-process background tool executors to report progress and terminal results through `task.send`. Progress updates now use executor-neutral coordinates internally, and background task types are exported from `eve/tools`.
