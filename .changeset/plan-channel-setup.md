---
"eve": patch
---

`eve channels add` now scaffolds portable channel variants when Vercel is unavailable and asks before deploying Vercel-integrated channels. Portable Slack setup uses environment credentials and records the required variables in `.env.example`.
