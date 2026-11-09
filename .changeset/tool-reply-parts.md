---
"eve": minor
---

Tools can add a part to the turn's reply with `replyPart`, such as a card shown beside the model's text.

`replyPart.build` runs after a successful call and returns the part's `value` and `fallbackText`. The session stream records it as `content.completed` with the tool's `kind` and `mediaType` and the `callId` of the call that wrote it, and the part stays in the turn's reply when the model replies again afterward. With `streamInput: true`, the call's input streams as `content.delta` previews for the part while the model writes it.
