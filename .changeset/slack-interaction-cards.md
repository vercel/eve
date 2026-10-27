---
"eve": minor
---

Slack renderers can restyle approval, question, and budget prompt cards with a new `interactionCard(card, next)` hook, while eve keeps routing, batching, action IDs, and card updates. Cards now update from the session for every request kind: a question answered by a typed reply or withdrawn, or a settled budget prompt, no longer keeps live buttons, and a freeform answer no longer erases requests grouped beside it.

Breaking changes:

- `SlackChannelState.pendingApprovalCards` is removed in favor of `interactionCards`. eve ignores the old field, so cards posted before the upgrade keep their buttons.
- `SlackTaskCard` is renamed to `SlackCardMessage`, the message type both `taskCard` and `interactionCard` return.
- An approval's buttons now disappear when an answer is admitted, not when the request settles, so a later click can't change an admitted answer.
- A denied approval's card now reads **Deny**, matching its button, instead of **Cancel**, and a direct-message request's thread note reports the same outcome as its card, such as `Answered: Approve by @alice.`
