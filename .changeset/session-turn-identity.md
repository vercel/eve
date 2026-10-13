---
"eve": patch
---

An expired session now reports its last turn to channel handlers instead of `turn_0`, and a failed session attributes the failure to the turn that was running, including after a resumed approval or a handoff.
