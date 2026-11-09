---
"eve": patch
---

Vercel sandboxes no longer send an expired `VERCEL_OIDC_TOKEN` to the Sandbox API, which failed builds with a 403 `invalidToken` error.

When `VERCEL_TEAM_ID` (or `VERCEL_ORG_ID`) and `VERCEL_PROJECT_ID` were set, eve used `VERCEL_OIDC_TOKEN` directly without checking its expiry, so a build that started after the token expired failed while preparing sandbox templates. eve now resolves the OIDC token through the Vercel OIDC helper, which rejects an expired token and refreshes it where it can, and falls back to `VERCEL_TOKEN` when it is set and the OIDC token can't be used.
