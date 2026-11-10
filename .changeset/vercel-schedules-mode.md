---
"eve": minor
---

Agents deployed to Vercel, including agents added to an app with `withEve`, now run schedules with Vercel Schedules through a private function instead of Vercel Cron Jobs.

The schedule names of `withEve` agents start with the agent's name. Building a `withEve` project requires Vercel CLI 65.14.0 or later.
