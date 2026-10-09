---
"eve": patch
---

Add `modelOptions.promptCache` for models eve calls directly. `promptCache: { anthropic: { ttl: "1h" } }` switches eve's Anthropic cache breakpoints to a 1-hour lifetime. `promptCache: { anthropic: {} }` turns breakpoints on for an Anthropic model eve can't recognize from its id, such as a Bedrock application inference profile.
