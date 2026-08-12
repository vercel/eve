---
"eve": patch
---

Self-hosted eve servers now await Workflow world and sandbox cleanup during SIGINT or SIGTERM, and local development asks worker-owned Workflow worlds to close before retiring a worker during reload or shutdown. Configured Worlds that release queue workers from `close()` can therefore resume durable sessions after restart without waiting for stale locks to expire.
