---
"eve": patch
---

Fix Slack `threadContext: { since: "last-agent-reply" }` treating every bot's message as the agent's own. In a thread where another Slack app also posts, the boundary was cut at the other bot's last message, silently dropping context (and sometimes leaving the agent with none). The channel now resolves its own bot id via `auth.test` and only marks the agent's own replies as the boundary.
