---
"eve": minor
---

Agents added to an app with `withEve` now run schedules with Vercel Schedules too, and every Vercel schedule name now starts with its agent's name.

Building a `withEve` project requires a Vercel CLI release that accepts schedules from a service's build output.
