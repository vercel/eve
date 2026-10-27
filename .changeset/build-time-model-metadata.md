---
"eve": patch
---

Dynamic models, dynamic subagent configs, and `ctx.agent(name, { model })` overrides now read context windows from the AI Gateway model catalog recorded at build time instead of downloading it at runtime; a model that catalog doesn't list fails until you return `modelContextWindowTokens` or rebuild. Builds no longer carry built-in limits for `anthropic/claude-opus-4.7`, `openai/gpt-5.4`, and `openai/gpt-5.4-mini`, so a static model needs the catalog, a cached copy, or `modelContextWindowTokens` to compile offline.
