---
"eve": minor
---

Slack sends a person's edit to a message the agent serves to that thread's session, as a `<slack_message_edit>` with a diff of the changed lines and the full edited text, and `slackChannel({ onMessageEdited })` decides which edits reach the agent.

An edit follows the channel's `turnPolicy` like any message: by default it joins a running turn, and if the agent already replied, it starts a new turn, which shows no thread status until its first tool call finishes; add the `no_reply` tool so the agent can stay quiet when an edit changes nothing. By default, eve sends edits to DMs, code channel messages, and messages that mention the agent before or after the edit. With an authored `onAppMention`, `onDirectMessage`, or `onMessage`, edits need their own `onMessageEdited`, so they can't skip those hooks' checks; until then they go to `onEvent` or are dropped.

The generated Slack app manifest now subscribes to the `message.channels`, `message.groups`, `message.im`, and `message.mpim` events and adds the `channels:history`, `groups:history`, `im:history`, and `mpim:history` scopes, which Slack requires to send edits. Reinstall the Slack app to grant them. With these events, the default handler also answers DMs without extra setup, and an authored `onEvent` receives every message event in channels the app has joined.
