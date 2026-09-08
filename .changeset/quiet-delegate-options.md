---
"eve": patch
---

Let parent agents choose a model, reasoning effort and cost ceiling for each task delegated to an opted-in local subagent. Authors configure allowed models with `delegationModels`; calls without overrides keep their defaults, and requested budgets cannot raise inherited or authored limits.
