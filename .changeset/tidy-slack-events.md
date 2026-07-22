---
"eve": patch
---

Add a generic Slack `onEvent` fallback for subscribed Events API callbacks. Handlers can use a Slack-bound `receive` function to start zero, one, or many agent turns while authored mention and direct-message handlers retain precedence.
