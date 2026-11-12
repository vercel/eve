---
"eve": patch
---

Let `auto()` route messages longer than 16,000 characters using the configured decision provider's input limits.

The decider receives the full text of the turn's opening input and up to seven earlier user and assistant messages. Larger inputs can increase decision cost and latency. Provider input-limit errors use the configured `fallback`, like other decision failures.
