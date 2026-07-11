---
"eve": minor
---

feat(eve): external cron mode for self-hosted builds (`EVE_EXTERNAL_CRON=1`)

Building with `EVE_EXTERNAL_CRON=1` on the node preset registers no in-process cron: the deployment instead mounts the same unguessable token cron route the Vercel preset uses (`POST /eve/v1/cron/<token>`, `x-vercel-cron-schedule` header, optional `CRON_SECRET` bearer check) and writes `.output/eve/cron-manifest.json` with the route path and each schedule's name and cron expression. Hosting platforms can own the clock — replica deduplication, catch-up policies, manual triggering — by driving that route from their own scheduler, exactly like Vercel Cron does.
