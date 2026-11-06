---
"eve": minor
---

Agents deployed to Vercel can now deliver schedules with Vercel Schedules instead of Cron Jobs by setting `experimental.schedules.vercel` to `"private"` or `"public"` in the root `agent.ts`.

Vercel Schedules is in beta and must be enabled for your Vercel team. The option is not supported yet for agents built as Vercel services, such as with `withEve`.
