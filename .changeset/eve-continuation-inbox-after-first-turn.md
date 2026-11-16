---
"eve": patch
---

A session started on a channel address with a message, such as a Slack thread's first message, claims its session-id inbox after its first step instead of before its first turn, taking one Workflow hook write off a new conversation's first reply.

Until then, commands, sign-in callbacks, and the session's idle timeout reach it by session id through its start Hook.
