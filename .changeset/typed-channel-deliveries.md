---
"eve": minor
---

Channel delivery hooks now receive typed `ChannelDelivery<TState>` payloads and return a replacement payload or nothing to preserve the input. Authored channels match their path-derived identity in hooks; remove `kindHint` and use `audience()` rather than `metadata().audience` to classify visibility.
