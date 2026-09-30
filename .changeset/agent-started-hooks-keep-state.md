---
"eve": patch
---

`agent.started` hooks keep the session state and sandbox changes they make. A child session that opens while the parent's model is generating appears on the parent stream when that model step ends.
