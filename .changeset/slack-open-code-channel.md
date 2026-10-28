---
"eve": patch
---

Add `openCodeChannel(ctx, slack, message, { name })` to `eve/channels/slack`, which a tool calls to move the Slack conversation it was called from into a new Slack code channel and continue the work there with the conversation so far. Wrap it in your own tool with your own description and inputs, and pass your Slack channel. It finds the conversation from `ctx.channel`, so it works when message hooks return their own auth. To write your own variant, Slack receive targets accept `codeChannel`. Message hooks can open a code channel without the model through `ctx.openCodeChannel()`.
