---
"eve": patch
---

Add an optional `fallback` model to `auto` model routing. When the evaluation model fails, eve now uses the configured fallback for the rest of the turn while preserving cancellation behavior.
