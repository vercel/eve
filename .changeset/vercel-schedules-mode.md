---
"eve": patch
---

Agents deployed to Vercel now run schedules with Vercel Schedules through a private function instead of Vercel Cron Jobs.

Vercel Schedules is in beta and must be enabled for your Vercel team. Agents added to an app with `withEve` keep using Cron Jobs, because Vercel doesn't accept schedules from a service's build output yet.
