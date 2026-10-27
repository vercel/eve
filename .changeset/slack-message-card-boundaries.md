---
"eve": minor
---

Slack `initialMessage` now accepts the same explicit inputs as `thread.post`: Markdown, text, raw blocks, or a card, with optional files. Supported message-card builders remain available and are documented.

Remove unsupported `Modal*`, `ExternalSelect*`, `TextInput*`, `CardJSXElement`, and `CardJSXProps` exports, plus the internal `isCardElement` and `cardChildToFallbackText` helpers. Replace label-only `TextInput` cards with `CardText`, use native Slack view data for custom modals, and use `cardToFallbackText` for complete cards.
