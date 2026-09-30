---
"eve": patch
---

Tools can now end a turn without a reply. Set `endsTurn: true` on a `defineTool` tool whose action is the whole answer, such as a reaction: once every call in the model's step succeeds, the turn completes with no final message, so channels and schedule sends post nothing. The new opt-in `no_reply` tool (`eve add tool/no_reply`, or `noReply()` from `eve/tools/no_reply`) uses it to let the agent stay quiet, for example when a scheduled check finds nothing to report. Slack now clears its thread status when a turn completes.
