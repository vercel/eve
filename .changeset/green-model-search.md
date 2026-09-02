---
"@eve/self-modification": patch
---

The self-modification subagent now searches the current `/model` catalog before resolving abbreviated or unknown model names. Requests such as “use sol” can use the exact matching model ID instead of requiring a manual clarification.
