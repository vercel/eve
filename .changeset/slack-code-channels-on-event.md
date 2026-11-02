---
"eve": patch
---

Answer un-mentioned Slack code channel messages when the channel also has `onEvent` but no `onAppMention`, instead of sending them to `onEvent`.

`onEvent` still receives messages posted outside code channels. To keep handling code channel messages yourself, add an `onAppMention` or `onMessage` hook.
