---
"eve": patch
---

Questions, approvals, and sign-in prompts from agents and workflow tool tasks now follow their task: the root session's stream carries `input.resolved` for each request once it is resolved, or with `outcome: "ignored"` when its task is cancelled, times out, or finishes first; a plain message answers a task's question when it is the only pending question and the session has no approval of its own pending; and requests from two agents asking through the same subagent both stay answerable. A detached task's requests survive unrelated messages, and the turn stays open until they are answered or the task is cancelled.
