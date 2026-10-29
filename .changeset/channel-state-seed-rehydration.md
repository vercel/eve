---
"eve": patch
---

Resumed sessions now fill in top-level channel `state` fields that a later deploy added to the `defineChannel` seed (or to a built-in channel's state), instead of leaving them `undefined`.

This runs at every step boundary, so a seed field a session deletes from `channel.state` comes back at the next step. Set the field to `null` (or `undefined`) to clear it instead.
