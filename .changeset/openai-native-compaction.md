---
"eve": minor
---

Set `experimental: { compaction: openaiCompaction() }` to compact with OpenAI's own compaction, imported from `eve/experimental/compaction`.

OpenAI answers the turn's request with an encrypted record of the history, which eve keeps as the history and sends with every later request. It works with `openai("gpt-...")` and with an `"openai/gpt-..."` AI Gateway string, which eve pins to OpenAI while the record is in the history. Another model, a failed call, or an answer without a record compacts with `fallback`, `defaultCompaction()` unless you pass another strategy.
