---
"eve": patch
---

Sessions started on eve 0.66 through 0.83 now move to a v27 deployment the next time they receive a message while idle, instead of staying on their original deployment indefinitely. The session keeps its stream and history, and new turns continue after its earlier events. A session that still has work running, or whose stream holds more than 100,000 lines, stays on the deployment that owns it.
