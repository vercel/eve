---
"eve": minor
---

Set `compaction: { compact: openaiCompaction() }` to compact with OpenAI's own compaction, imported from `eve/compaction`.

eve sends the turn's request with OpenAI's `compaction_trigger`, keeps the encrypted record OpenAI returns as the history, and sends it with every later request. The agent's own `store` setting applies to the compaction call and to every later request: by default OpenAI keeps the record and eve refers to it by id, and with `store: false` on the agent eve sends the record inline, so the session stays resumable after OpenAI's retention. A turn compacts again when its tool results have grown the history past the threshold or past the window. The strategy runs on the OpenAI Responses API called directly; on another model, or when the call fails, it summarizes as text with `fixedTail()` and logs why. A session that holds the record and switches to another provider logs a warning on each request.
