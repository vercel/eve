---
"eve": patch
---

Add `limits.maxInputTokensPerSession` and `limits.maxOutputTokensPerSession` to stop a durable session from starting more model calls after its accumulated provider-reported input or output token usage reaches the configured cap. Root sessions default to a 40M input-token budget, delegated subagent sessions default to 5M, and authored input limits override those defaults.
