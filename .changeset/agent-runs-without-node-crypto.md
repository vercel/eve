---
"@vercel/agent-runs": patch
---

Trace ids, span ids and content hashes no longer need `node:crypto`, so the package runs in a browser too; Node output is unchanged.
