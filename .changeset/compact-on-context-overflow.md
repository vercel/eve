---
"eve": patch
---

When a provider rejects a model call as longer than the context window, eve now compacts the conversation once and retries the call in the same step instead of failing the turn. A custom `LanguageModel` can signal this by throwing an error with `code: "context_length_exceeded"`.
