---
"eve": patch
---

fix(slack): route HITL input-request prompts through GFM → mrkdwn conversion (#1293)

Model-authored prompts in Slack HITL input-request widgets were being placed into `{ type: "mrkdwn" }` blocks verbatim — `**bold**`, `__bold__`, `~~strike~~`, and `[label](url)` rendered as literal punctuation instead of formatting. The asymmetry with `thread.post(string)` (which converts via eve's `gfmToSlackMrkdwn`) made every eve+Slack app rediscover the same workaround.

`renderInputRequestBlocks` and `buildFreeformModalView` now both pass the prompt through `gfmToSlackMrkdwn` before truncating, matching the behavior of the rest of the Slack surface. Code fences and inline code are preserved untouched by the fence-aware splitter already used elsewhere.

Includes regression coverage for both the block-renderer path and the modal path.

Closes #1293
