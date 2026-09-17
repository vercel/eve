---
"eve": patch
---

Add development commands to generated hostless workspace services so `vercel dev --local` can start every agent. Default `defineWorkspaceAgent` transports route through the local Vercel service graph without deployment credentials.
