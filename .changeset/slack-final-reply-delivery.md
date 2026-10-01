---
"eve": patch
---

Slack no longer drops a final reply without a trace. When Slack refuses eve's default reply as too large or malformed, eve uploads it as a Markdown snippet. When a reply still isn't delivered, including when a custom renderer throws, eve posts a short notice with an error id, without the reply, and tells the model on the next message that the user never saw it. Custom renderers can opt in to the same fallbacks by posting through `postCompletedSlackReply` from `eve/channels/slack`, which tries their blocks, then native Markdown, then a snippet, using only the content they pass.
