---
"eve": patch
---

`withEve` now writes `.vercel/output/config.json` only during `next build`, with only eve's own routes. Routes from Next.js or an earlier build are no longer carried forward and appended a second time, and loading `next.config` outside the build (e.g. `next start` before `vercel deploy --prebuilt`) leaves the finished output untouched.
