---
"eve": patch
---

Local `vercel build` runs now select the hosted Workflow runtime and prewarm sandbox templates, so their output can be deployed with `vercel deploy --prebuilt`. Builds that require templates fail with setup guidance when Vercel OIDC credentials are unavailable instead of emitting broken prebuilt output.
