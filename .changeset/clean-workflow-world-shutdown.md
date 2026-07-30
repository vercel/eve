---
"eve": patch
---

Self-hosted eve servers now await Workflow world and sandbox cleanup through one coordinated Nitro shutdown lifecycle before exiting on SIGINT or SIGTERM. Local development also closes worker-owned Workflow worlds before retiring a worker during reload or shutdown. This releases queue workers immediately so durable sessions can resume after a process or development-worker restart without waiting for stale locks to expire.
