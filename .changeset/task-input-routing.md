---
"eve": patch
---

A subagent's questions, approvals, and sign-in prompts now follow its task: the root session's stream carries `input.resolved` for each of a subagent's requests once it is resolved, or with `outcome: "ignored"` when its task is cancelled, times out, or finishes first; a plain message answers a subagent's question when it is the only pending question; and requests from two agents asking through the same subagent both stay answerable. Cancelling a turn no longer withdraws the pending requests of background tasks.
