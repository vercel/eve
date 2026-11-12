---
"eve": patch
---

Vercel sandboxes refresh or replace expired and near-expiry `VERCEL_OIDC_TOKEN` credentials before template builds to avoid 403 `invalidToken` errors.

When `VERCEL_TEAM_ID` (or `VERCEL_ORG_ID`) and `VERCEL_PROJECT_ID` were set, eve used `VERCEL_OIDC_TOKEN` directly without checking its expiry, so a build that started after the token expired failed while preparing sandbox templates. eve now resolves the OIDC token through the Vercel OIDC helper, which attempts refresh within five minutes of expiry, and falls back to `VERCEL_TOKEN` when it is set and the OIDC token can't be used.
