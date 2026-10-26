---
"eve": minor
---

Sends, channels, and schedules now accept eve-owned `MessageContent`; images use file parts, and Chat SDK's `messageToUserContent` is renamed to `messageContentOf`. File parts sent through `ctx.agent().send()` must contain HTTP(S) URLs, not inline bytes or base64.
