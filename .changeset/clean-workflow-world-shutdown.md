---
"eve": patch
---

Self-hosted eve servers now await Workflow world and sandbox cleanup through one coordinated Nitro shutdown lifecycle before exiting on SIGINT or SIGTERM. This releases queue workers immediately so durable sessions can resume after a process restart without waiting for stale locks to expire.
