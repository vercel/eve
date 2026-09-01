---
"eve": patch
---

Add optional `audience` on Slack proactive `receive` / `ctx.send` targets so webhook and schedule handoffs can pass channel visibility without an extra Slack API call.
