---
"eve": patch
---

Added Slack `threadReplies` configuration for responding to replies in active threads with arbitrary durable user-defined state. `onReply` independently decides whether to respond and which JSON-serializable state is available to the next thread reply.
