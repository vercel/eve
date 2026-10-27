---
"eve": minor
---

Slack renderers can restyle approval, question, and budget prompt cards with a new `interactionCard(card, next)` hook, while eve keeps routing, batching, action IDs, and card updates. Cards now update from the session for every request kind, so a question answered by a typed reply or withdrawn, or a settled budget prompt, no longer keeps live buttons.

Breaking changes:

- `SlackChannelState.pendingApprovalCards` is replaced by `interactionCards`. Cards posted before the upgrade keep their buttons.
- `SlackTaskCard` is renamed to `SlackCardMessage`, which both `taskCard` and `interactionCard` return.
- Clicking a question no longer rewrites its card from the webhook. The buttons stay until the session admits the answer, and apps that post eve's controls themselves no longer get that rewrite.
- An approval's buttons disappear once its answer is admitted, so a later click can't change it. A denied approval reads **Deny** instead of **Cancel**, and a direct-message request's thread note reports the same outcome as its card.
