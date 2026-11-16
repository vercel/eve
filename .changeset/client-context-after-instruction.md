---
"eve": patch
---

Place a turn's client context after the user-role instructions and skill or tool catalog updates eve announces in that turn, so the model reads it right before the message and the next turn keeps the prompt cache.

User-role instructions and catalog updates join the conversation history, but client context does not. Since #5638, the client context sat ahead of them, so the next turn's prompt diverged at that point.
