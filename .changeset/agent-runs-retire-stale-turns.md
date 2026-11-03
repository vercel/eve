---
"@vercel/agent-runs": patch
"eve": patch
---

Fix durable agent traces keeping every finished turn that called tools in parallel: each one stayed in the session's serialized context, so step inputs grew with every turn.

A checkpoint this process had already written, read back through another execution context, was treated as another process's write and forked the turn's trace tree; the stale copy then overwrote the tool completions and the checkpoint was never deleted. A replaced tree now also stops persisting.
