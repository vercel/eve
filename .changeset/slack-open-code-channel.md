---
"eve": patch
---

Add the `open_code_channel` tool (`openCodeChannel()` from `eve/tools/open_code_channel`), which moves a Slack conversation into a new Slack code channel through the Slack channel that serves it, and continues the work there with the conversation so far. It finds the conversation from the Slack channel's metadata, so it works when message hooks return their own auth. To write your own variant, Slack receive targets accept `codeChannel`, which Slack opens only from the calling tool's own conversation. Message hooks can open a code channel without the model through `ctx.openCodeChannel()`.
