---
"eve": patch
---

Clarify Vercel build failures when an agent pins the Docker or microsandbox sandbox backend. The error now explains those local backends are unavailable on Vercel and directs users to `defaultBackend()` or an explicit Vercel-compatible backend.
