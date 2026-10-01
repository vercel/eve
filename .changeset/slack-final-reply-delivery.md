---
"eve": patch
---

Slack no longer drops a final reply without a trace when a custom renderer posts it. If Slack refuses the reply as too large or malformed, eve uploads it as a Markdown snippet. If delivery still fails, eve posts a short notice with an error id and tells the model on the next message that the user never saw the reply. Renderers can reuse eve's long-reply delivery with `postCompletedSlackReply` and `SLACK_MARKDOWN_TEXT_MAX_LENGTH` from `eve/channels/slack`.
