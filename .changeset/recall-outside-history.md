---
"eve": minor
---

Recalled memory now stays outside history. Each model call reads each turn's recall just ahead of that turn's input, so the prompt ahead of it stays cached; a message with an `id` replaces the one an earlier turn recalled. Compaction never summarizes it, so `recall["compaction.completed"]` and `visibility` are removed. A `capture["compaction.requested"]` that throws fails the compaction, and history stays as it was.
