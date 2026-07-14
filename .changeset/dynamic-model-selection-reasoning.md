---
"eve": patch
---

Dynamic model selection now accepts a per-selection `reasoning` field alongside `model`, `modelContextWindowTokens`, and `modelOptions`. A `defineDynamic` resolver can return `{ model, reasoning }` to override the agent-level reasoning effort for the selected model (for example, dropping a downshifted classifier to `low`); omitting it keeps the agent-level `reasoning`.
