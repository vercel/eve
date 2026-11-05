---
"eve": patch
---

Trace questions and sign-ins from workflow tools such as `ask_question`, which had no `agent.approval` span and never reached instrumentation providers.

A workflow run has no session of its own, so the session that owns its tool call now reports its requests on `interaction.opened` and `interaction.settled`. A request that a subagent or other child session asks is still reported once, by that session.
