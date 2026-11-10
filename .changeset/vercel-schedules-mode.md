---
"eve": minor
---

Agents deployed to Vercel, including agents added to an app with `withEve`, now run schedules with Vercel Schedules through a private function instead of Vercel Cron Jobs.

Each Vercel schedule is named after its file, such as `eve.billing.sweep` for `schedules/billing/sweep.ts`, and `withEve` agents add the agent's name, such as `eve.billing.heartbeat`. Building a `withEve` project requires Vercel CLI 65.14.0 or later.
