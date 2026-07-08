---
"eve": patch
---

Export `callSlackApi` and `resolveSlackBotToken` from `eve/channels/slack`. Code running outside a webhook-side handler — schedules resolving reactions or reading history, for example — has no `ctx.slack` handle; these were the internal primitives behind `slack.request`, already public-shaped and documented, and are now importable so apps stop hand-rolling `fetch` against the Slack Web API.
