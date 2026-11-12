---
"eve": patch
---

Vercel builds without `VERCEL_OIDC_TOKEN` no longer fail for agents whose sandbox templates have nothing to prepare, such as a freshly scaffolded agent with no sandbox, skills, or workspace files.

Templates with a `prepare` callback, managed workspace or skill files, or a Vercel `source` still require the token. Builds without it fail with the instruction to run `vercel link` and `vercel pull`. Unrelated provider preparation errors retain their original messages.
