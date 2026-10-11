---
"eve": patch
---

Memory recalled on `compaction.completed` during a turn now joins history before the turn's latest user message, where `turn.started` recall goes, instead of after it. The question stays the last user message the model reads, with client context between the recalled memory and the question. Compaction between turns still appends the recall.
