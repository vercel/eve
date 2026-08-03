---
"eve": patch
---

Prevent task completion from starting a duplicate parent turn when `task_await` already reports that ready transition. Cancelled awaits release their wake claims so later task completion still wakes the parent.
