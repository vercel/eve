---
"eve": patch
---

`ctx.thread.postEphemeral()` on a fresh top-level Slack message now posts to the channel instead of an empty thread, where Slack hid it. Replies inside an existing thread stay threaded.
