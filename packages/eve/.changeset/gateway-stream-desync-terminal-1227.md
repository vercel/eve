---
"eve": patch
---

Classify the AI SDK stream-assembler desync (`text part <id> not found`) as terminal instead of recoverable (#1227)

When a provider emits an interleaved stream the assembler cannot track (observed with `deepseek/deepseek-v4-flash` reasoning parts through the AI Gateway), `classifyModelCallError` now returns `"terminal"` so the step fails instead of parking the session for a durable full-turn replay. Replaying the whole tool loop cannot fix a malformed stream — the provider emits the same broken frame sequence — so the previous `recoverable` catch-all turned single subagent turns into 15-70 minute silent replay loops and inflated runs to 50-69M replayed cache-read tokens. `isStreamAssemblerDesyncError` is exported for the classifier and future call-site guards.
