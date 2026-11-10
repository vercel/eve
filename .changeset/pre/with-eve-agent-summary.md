---
"eve": patch
---

Show workspace agents on the Vercel project overview card when `vercel.ts` composes them with `withEve`.

`withEve` now writes the root `.eve/agent-summary.json` index that points Vercel at each member's summary, matching the hostless `eve build` path. Thanks @cnaccio for reporting this in #5706.
