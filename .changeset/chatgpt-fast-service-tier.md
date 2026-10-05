---
"eve": patch
---

`chatgpt()` now sends `serviceTier: "fast"` to the Codex backend as `priority`, the value the Codex CLI uses for Fast mode, instead of failing with `400 Unsupported service_tier: fast`.
