---
"eve": patch
---

Delegated agents again share and count against the parent's session token and cost budgets: agent tasks started in the same model step split the parent's remaining quota, and every child turn's usage, including remote agents and nested subagents, now counts toward the parent's `maxInputTokensPerSession`, `maxOutputTokensPerSession`, and `maxTokenCostUsdPerSession` and the usage the parent reports.
