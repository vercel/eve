---
"eve": minor
---

The eval assertion `awaitingInput()` now accepts an interaction filter and passes only when every pending request matches it.

The filter takes the same fields as `requireInteraction`, such as `{ kind: "approval" }`. Eval run facts gain `openInteractions`, the requests a run is parked on.
