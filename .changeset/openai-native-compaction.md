---
"eve": minor
---

Set `compaction: { compact: openaiCompaction() }` to compact with OpenAI's own compaction, imported from `eve/compaction`.

eve sends the turn's request with OpenAI's `compaction_trigger` and `store: false`, keeps the encrypted record OpenAI returns as the history, and sends it with every later request. It runs on the OpenAI Responses API called directly; on another model, or when the call fails, it summarizes as text with `fixedTail()` and logs why. A session that holds the record and switches to another provider logs a warning on each request.
