---
"eve": patch
---

Eve now emits `workflow.stream.follow.read` spans while following newly created runs, measuring each event from its durable write timestamp to the reader without counting replayed events.
