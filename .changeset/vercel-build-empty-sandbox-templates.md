---
"eve": patch
---

Vercel builds without `VERCEL_OIDC_TOKEN` no longer fail for agents whose sandbox templates have nothing to prepare, such as a freshly scaffolded agent with no sandbox, skills, or workspace files.

Templates that do need preparation still fail the build with the existing instruction to run `vercel link` and `vercel pull`.
