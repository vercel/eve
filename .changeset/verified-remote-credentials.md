---
"eve": patch
---

Verify remote Vercel deployment origins against the owner and project supplied by `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, or by a local project link, before sending ambient credentials. Remote dev and eval clients now refresh scoped OIDC tokens per request and refuse to forward credentials across redirects. Remote `eve dev` and `eve eval --url` targets now require `https://` (loopback hosts may still use `http://`).
