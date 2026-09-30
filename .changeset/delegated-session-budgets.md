---
"eve": patch
---

Delegated agents again share and count against the parent's session token and cost budgets: agent tasks started in the same model step split the parent's remaining quota, and delegated usage, including remote agents and nested subagents, counts toward the parent's `maxInputTokensPerSession`, `maxOutputTokensPerSession`, and `maxTokenCostUsdPerSession` and the usage the parent reports. An agent task's usage counts with each reply and when a cancelled turn ends; other workflow tools' `ctx.agent` usage counts when the tool replies or finishes.
