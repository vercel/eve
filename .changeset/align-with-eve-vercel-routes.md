---
"eve": minor
---

Named workspace agent routes now use `/eve/<name>/v1/*` across `eve/next`, `eve/vercel`, and agent-only workspace builds. Update existing named-agent URLs to the new route; root single-agent routes remain at `/eve/v1/*`, and `eve/vercel` can now compose them.
