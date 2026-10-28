---
"eve": minor
---

Slack `initialMessage` now accepts Markdown, text, raw blocks, or a card, with optional files uploaded into the root message's thread.

Remove unsupported `Modal*`, `ExternalSelect*`, `TextInput*`, `CardJSXElement`, `CardJSXProps`, `isCardElement`, and `cardChildToFallbackText` exports, plus the card builders' JSX-props overloads and their `*Props`, `ContainerProps`, and `ChatElement` types. Call builders with their data forms such as `Button({ id, label })`, use `CardText` for labels, native Slack view data for modals, and `cardToFallbackText` for whole cards (see [Slack cards](https://eve.dev/docs/channels/slack#cards)).
