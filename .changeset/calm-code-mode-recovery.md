---
"eve": patch
---

Fix Code Mode suspension around `try`/`catch` and `finally`, and return generated-program errors to the model without repeating the same source in workflow retries. Restore guidance to keep a task's related tool calls in one program.
