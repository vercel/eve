---
"eve": minor
---

Remove `defineAgent({ experimental: { codeMode } })` and the `EVE_EXPERIMENTAL_CODE_MODE` fallback. Tools are always exposed directly to the model; model-authored JavaScript orchestration remains available through the experimental `Workflow` tool for subagents and remote agents.
