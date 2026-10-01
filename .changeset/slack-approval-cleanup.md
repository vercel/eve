---
"eve": patch
---

Slack now cleans up after a tool approval. Once it resolves, the separate tool-input post is deleted, a direct-message approval's `Waiting on approval` note in the thread shows the outcome, and the card loses its buttons even when the approval ends without a click. The `Checking whether you can respond to this approval…` notice is no longer posted, since Slack cannot remove it afterwards.
