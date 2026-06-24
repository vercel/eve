---
"eve": patch
---

`/vc:auth` now resolves the target Vercel project and owning team directly from the deployment URL instead of prompting you to pick a team and project. You can authenticate any deployment you can access — including custom domains and aliases — without a picker, and when access is denied (for example an expired team SSO session) it re-authenticates and retries.
