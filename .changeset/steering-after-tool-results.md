---
"eve": patch
---

A message that steers a turn right after a tool call, such as a question sent while a task works, now gets answered on Anthropic models. Before, the message reached the model in the same turn as the tool results, and Claude often treated it as tool output and kept waiting on its tasks without replying.
