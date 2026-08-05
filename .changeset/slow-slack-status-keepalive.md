---
"eve": patch
---

Slack now keeps thread statuses visible during long-running work, including durable waits on subagents, instead of letting them expire after two minutes. Set `statusKeepalive: false` when an agent provides its own status refresh loop.
