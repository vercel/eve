---
"eve": minor
---

Channel delivery hooks now receive typed `ChannelDelivery` payloads and return replacements; use `channel.state` for state changes. `kindHint` is removed; use path-derived `channel:<name>` identities, `audience()` visibility classification, and the renamed CORS options described in the [v27 upgrade guide](https://eve.dev/docs/concepts/upgrade-to-v27-events).
