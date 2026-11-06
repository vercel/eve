---
"eve": minor
---

Add `message.actionToken` to Slack messages, read from Slack's `action_token` at the top level of the event or under `assistant_thread`.

Hooks no longer need to parse `message.raw` for the token that Slack's data access APIs, such as `assistant.search.context`, require. eve doesn't add it to `defaultSlackAuth` or channel state.
