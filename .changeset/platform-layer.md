---
"eve": patch
---

eve now reads Vercel platform facts and capabilities through one internal platform context, so the code that depends on Vercel, including Vercel OIDC route auth, lives in one place; `eve/channels/auth` exports and runtime behavior are unchanged.
