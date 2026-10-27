---
"eve": patch
---

Slack renderers can restyle approval, question, and budget prompt cards with a new `interactionCard(card, next)` hook, while eve keeps routing, batching, action IDs, and card updates. Cards now update from the session for every request kind: an admitted answer shows right away, and a question answered by a typed reply or withdrawn, or a settled budget prompt, no longer keeps live buttons.
