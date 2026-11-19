---
"eve": patch
---

The local self-modification subagent, and any dynamic subagent that passes `ctx.model.id` along, now runs on the parent's own provider model.

Before, a parent on `chatgpt()`, `mockModel()`, or a direct provider instance sent the subagent's model calls to AI Gateway under the parent's id.
