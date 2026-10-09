---
"eve": patch
---

eve now runs every local tool call itself; the AI SDK only calls the model. A model's calls run once its response ends rather than as each call streams in, through the same path as calls a person approved, including the approval policy, input validation, streamed progress, and telemetry.
