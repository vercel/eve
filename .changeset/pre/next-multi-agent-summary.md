---
"eve": patch
---

The Vercel project overview card now shows the agents' tools, schedules, and connections for a Next.js app that hosts an `agents/` workspace through `withEve` from `eve/next`.

During `next build`, `withEve` now writes the workspace's `.eve/agent-summary.json` index, the same index that `withEve` from `eve/vercel` writes since #5710. Standalone agents and agents configured with the `agents` option do not change.
