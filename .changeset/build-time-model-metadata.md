---
"eve": patch
---

Dynamic models, dynamic subagent configs, and `ctx.agent(name, { model })` overrides now read context windows from the AI Gateway model catalog recorded at build time, instead of downloading the full catalog at runtime for each new session or override. A model that catalog doesn't list fails with an error that names when the catalog was read; return `modelContextWindowTokens` or rebuild. A build that can't reach the catalog warns with `compile/model-metadata-unavailable`.
