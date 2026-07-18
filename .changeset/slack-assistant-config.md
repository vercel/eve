---
"eve": patch
---

`slackChannel` accepts two new assistant-thread options: `loadingMessages`, a set of rotating typing-indicator statuses replacing the default `"Thinking..."` / `"Working..."`, and `suggestedPrompts`, prompt chips applied when a user opens an assistant thread (static payload or per-thread resolver).
