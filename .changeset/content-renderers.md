---
"eve": minor
---

Content renderers in `agent/renderers/` draw reply parts of one media type natively, such as a tool's card in Slack.

A renderer from `defineContentRenderer` in `eve/renderers` returns a card built with `eve/cards`, which Slack and the Chat SDK channel post natively, or markdown, which the GitHub and Linear channels post. While a tool's `replyPart` streams, the card previews and updates as the model writes it, and a failed call removes it. Extensions can contribute renderers from `extension/renderers/`; the agent's own renderer wins for the same media type.
