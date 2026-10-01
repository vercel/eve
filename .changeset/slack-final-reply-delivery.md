---
"eve": patch
---

Slack no longer drops a final reply without a trace when a custom renderer posts it. If Slack refuses the reply as too large or malformed, eve posts it again as one plain Markdown message when it fits in 12,000 characters, and otherwise, or when that is refused too, uploads it as a Markdown snippet. If delivery still fails, eve posts a short notice with an error id and tells the model on the next message that the user never saw the reply. Renderers can reuse eve's long-reply delivery with `postCompletedSlackReply` and `SLACK_MARKDOWN_TEXT_MAX_LENGTH` from `eve/channels/slack`.
