---
"eve": patch
---

A subagent's questions, approvals, and sign-in prompts now follow its task: the root session's stream also carries the subagent's `input.resolved` for each request it resolves, a plain message answers a subagent's question when it is the only pending question, and requests from two agents asking through the same subagent both stay answerable. Cancelling a turn no longer withdraws the pending requests of background tasks.
