---
"eve": patch
---

One-time schedules in `eve dev` and `inMemoryScheduleProvider` now read `at` in the schedule's timezone, so short delays no longer complete immediately on machines ahead of UTC.

The in-memory provider used to parse `at` in the process's local timezone and ignore `timezone`, which marked a schedule due in a minute as already completed and made invoking it fail.
