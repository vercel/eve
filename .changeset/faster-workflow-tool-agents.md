---
"eve": patch
---

Workflow tools and the agents they open start faster. Tasks begin work sooner, `ctx.agent().send()` no longer waits for the agent's session to boot, a model step that starts several tasks starts them in parallel, and a fan-out's agent starts, progress, and results reach the session together instead of one at a time.
