---
"eve": patch
---

A subagent's tool approval now stays open on the parent until the subagent settles it. If the subagent's response policy refuses the person who answered, someone else can still answer it, by text or button, instead of the prompt disappearing while the subagent waits. The parent closes the prompt when it relays the subagent's own `input.resolved`, so channels such as Telegram and Discord clear its buttons.
