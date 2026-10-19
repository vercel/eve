---
"eve": minor
---

Breaking: replace `limits.maxInputTokensPerSession`, `limits.maxOutputTokensPerSession` and `limits.maxTokenCostUsdPerSession` with one `limits.sessionUsage` function. It receives the session's `total` usage and its `window` since the last approved continuation, and returns `true` when the limit is reached; Continue starts a new window. The default is 40M new input tokens (input minus cache reads) per window. Subagents now check their own window with their own `sessionUsage` or the root agent's instead of receiving a share of the parent's remaining quota. Sessions that can't ask now fail with `SESSION_USAGE_LIMIT_REACHED`, replacing `SESSION_TOKEN_LIMIT_REACHED` and `SESSION_TOKEN_COST_LIMIT_REACHED`.
