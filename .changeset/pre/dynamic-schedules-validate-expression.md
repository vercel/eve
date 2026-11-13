---
"eve": minor
---

Dynamic schedules reject a cron expression that Vercel Schedules can't run before the write is prepared, so a model's call fails before a person is asked to approve it.

Vercel Schedules takes numeric fields only, and not both a day of the month and a day of the week. An expression that breaks these rules, such as one with `MON` or `JAN`, now fails with an error that says how to write it. `eve dev` applies the same rules. A custom `ScheduleProvider` can implement the optional `validateExpression` to check timing the same way.
