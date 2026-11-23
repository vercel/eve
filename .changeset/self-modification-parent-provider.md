---
"eve": patch
---

The self-modification subagents, when no model is configured for them, now run on the parent's own provider model.

Before, a parent on `chatgpt()`, `mockModel()`, or a direct provider instance sent the subagent's model calls to AI Gateway under the parent's id. A dynamic subagent that names a model string, even one equal to the parent's id, still resolves through AI Gateway.
