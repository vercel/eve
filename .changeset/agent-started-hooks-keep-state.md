---
"eve": patch
---

`agent.started` hooks keep the session state and sandbox changes they make, even when the child session opens during the parent's model step. The event still reaches the parent stream as soon as the child opens; its hooks run once that step ends.
