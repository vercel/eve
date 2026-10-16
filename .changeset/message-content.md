---
"eve": minor
---

Sends, channel delivery, and schedules use eve-owned `MessageContent` instead of AI SDK `UserContent`; images are file parts, and Chat SDK uses `messageContentOf` instead of `messageToUserContent`. Workflow `ctx.agent().send()` also accepts text/file parts, but file data must be an HTTP(S) URL rather than inline bytes or base64.
