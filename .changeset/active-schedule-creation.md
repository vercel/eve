---
"eve": patch
---

Schedule creation no longer accepts an initial state: schedules are created active by default (or completed if a one-time schedule is already past). Use the existing enable and disable operations to change a schedule's state after creation.
