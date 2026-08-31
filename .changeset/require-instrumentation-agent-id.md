---
"eve": patch
---

Instrumentation trace policies now always receive the active agent's canonical ID, including for configless agents and cancelled turns. Explicit provider policies must be bound to an agent before events are published.
