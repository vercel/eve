---
"eve": minor
---

- Adds `audience(input)` to `defineChannel` and a durable conversation context for trace policies.
- `eveChannel` now defaults anonymous callers to public and authenticated callers to private. Trace content is public-or-development by default.
- `metadata().audience` is deprecated. Channel epoch 19 extensions keep working through a warned fallback; move classification to `audience(input)`.
