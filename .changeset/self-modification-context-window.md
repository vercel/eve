---
"eve": patch
---

Dynamic subagents can return `ctx.model` as their `model` to run on the parent's model, keeping its provider and context window instead of rebuilding it from its id through AI Gateway. The self-modification subagent now does this, so it stays available on custom and authored provider models such as `mockModel`.
