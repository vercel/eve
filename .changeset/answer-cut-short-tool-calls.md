---
"eve": patch
---

A model step that ends early, for example at the output token limit, no longer leaves its tool calls unanswered. The AI SDK does not run tools from such a step, so the next model call failed with "Tool results are missing". eve now answers each skipped call with an error, and the model can call the tool again.
