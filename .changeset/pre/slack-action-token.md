---
"eve": minor
---

Add Slack's `action_token` to `defaultSlackAuth` as the `action_token` attribute, so tools can call the Real-time Search API without channel code.

eve also exposes the token as `message.actionToken`, read from the top level of the event or from `assistant_thread`, where Slack sends it in app threads.
