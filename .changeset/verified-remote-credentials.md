---
"eve": patch
---

Verify remote Vercel deployment origins against the locally linked owner and project before sending ambient credentials. Remote dev and eval clients now refresh scoped OIDC tokens per request and refuse to forward credentials across redirects.
