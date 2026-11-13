---
"eve": minor
---

Schedules can set `timezone` to run their `cron` expression in an IANA timezone, such as `"America/New_York"`, instead of UTC.

`defineSchedule({ cron: "0 9 * * 1-5", timezone: "America/New_York", ... })` fires at 09:00 New York time all year, through daylight saving changes. Markdown schedules set `timezone` in frontmatter. Vercel Schedules evaluates the timezone. A build for `eve start` fails when a schedule sets `timezone`, because Nitro's in-process cron runner cannot use one.
