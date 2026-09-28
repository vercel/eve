---
"eve": patch
---

The parent stream now publishes `agent.started` for a session a task opens as soon as the session opens, even while the parent's model is still generating, so clients can follow the child while it works instead of after the parent's next step.
