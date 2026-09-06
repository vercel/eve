---
"eve": patch
---

Resolve workflow path aliases from the application config and bundle only workflows reachable from the agent. Unresolved workflow imports now fail the build instead of producing a bundle that crashes every durable session.
