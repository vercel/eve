---
"eve": patch
---

Workflow tools can start or reach sessions on the agent's channels with `ctx.sendToChannel(name, message, { target, auth })`, such as forking a conversation into a new Slack or Teams thread. A retried send reaches an existing session once. Cross-channel `to().send()` also accepts `history`, which eve adds to the destination session. Teams' default auth now includes the conversation's `service_url`, so a tool can address the current Teams conversation. Workflow tools also get `ctx.channel` (the calling session's channel `name`, `kind`, and `metadata`), and a channel's `receive` hook gets the sending tool's session as `input.caller`.
