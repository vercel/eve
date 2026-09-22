---
"eve": patch
---

Keep a delegated agent task open when its model turn yields with nested background work pending. Deliver the final result after that work finishes, including usage accumulated across the yielded turns, instead of reporting the interim reply as completion.

Propagate task cancellation to a yielded child's nested background work for self, local, and remote delegation, without waking the cancelled child on its nested task notifications. Keep that notification decision in the durable task state so it survives replay.
