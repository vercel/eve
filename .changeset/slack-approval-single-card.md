---
"eve": minor
---

Slack tool approvals now render as one card that holds the prompt, the tool input, and the **Approve** and **Deny** buttons.

The card replaces the separate approval card and collapsed **Tool input** block. It lists up to 10 top-level input fields within a fixed size budget, and a batch of large approvals splits across messages, so a click's callback stays bounded however large the input is. Approvals without input keep the compact card. An answered approval keeps its input preview as a record of what was approved, where eve used to delete the separate tool-input message when the request ended.

If you call `renderInteractionBlocks` from `eve/channels/slack`, an approval with tool input now returns one `container` block whose `child_blocks` hold the input preview and an `actions` block, instead of a `card` with `actions` followed by a **Tool input** container. Code that reads `actions` or stamps `block_id`s on interactive blocks should also look inside `child_blocks`.
