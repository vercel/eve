---
"eve": patch
---

Convert model-authored markdown to Slack mrkdwn in HITL input-request prompts. The question text on the input-request widget and on the freeform-answer modal was placed into `mrkdwn` sections verbatim, so `**bold**` and `[links](url)` rendered as literal punctuation — even though the same text renders correctly when posted as a normal message. Both surfaces now run the prompt through `gfmToSlackMrkdwn`, matching the rest of the adapter.
