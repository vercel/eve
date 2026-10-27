---
"eve": patch
---

Idle sessions owned by an eve 0.83 deployment now move to a deployment running this release when their next message arrives, instead of staying on the old deployment. The session keeps its v26 history and records new turns in v27 after it; sessions with work in flight, or driven by a parent or remote caller, still stay where they are.
