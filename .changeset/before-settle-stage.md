---
"eve": patch
---

Add experimental `experimental.loop.beforeSettle` to `defineAgent`, which can send a reply back to the model with a note before the turn settles.

The stage runs only when the turn would complete, is capped by `maxContinuations` (default 3), and fails the turn with a generic error when it throws.
