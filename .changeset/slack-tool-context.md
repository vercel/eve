---
"eve": minor
---

Add `slackToolContext(ctx, slack)` so tools can call the Slack Web API with the serving channel's credentials.

It returns the conversation a tool call came from (`channelId`, `threadTs`, `codeChannel`, `teamId`, and `triggeringMessageTs`) with a `request(operation, body)` built from the channel's bot token and `api` option, or `null` when the session isn't on Slack. `SlackInstrumentationMetadata` now lists `triggeringMessageTs`.
