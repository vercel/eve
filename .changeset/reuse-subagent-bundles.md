---
"eve": patch
---

Subagent turn steps now reuse the subagent's compiled definition instead of rebuilding it each step.

Before, eve created a new compiled bundle for a subagent on every lookup, so it set up the subagent's definitions again on every step. It now keeps one bundle for each subagent until the agent's compiled output changes.
