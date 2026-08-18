---
"eve": patch
---

Add `ctx.isDMOrPrivateChannel()` to Slack message handlers so agents can detect DMs, group DMs, and private channels without parsing raw events or implementing their own Slack API fallback.
