---
"eve": patch
---

Resumed sessions now fill in channel `state` fields that a later deploy added to the `defineChannel` seed (or to a built-in channel's state), instead of leaving them `undefined`. Stored values still win, including `null`, but a field a session set to `undefined` now reverts to its seed value on resume, so store `null` to keep a field cleared.
