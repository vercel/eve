---
"eve": patch
---

Make `withEve()` discover project-level `agents/` workspace members, mounting each named agent through a Next.js app without repeating the agent map in `next.config.ts`. Workspace peers declared with `defineWorkspaceAgent()` route through the named Next.js mount automatically.
