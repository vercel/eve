---
"eve": patch
---

Fix approved tool calls silently not executing when task state or a dynamic skill announcement was injected on the resume step. The runtime context was appended after the approval response, so the AI SDK skipped the approved tool and providers rejected the prompt with errors like `No tool output found for function call`.
