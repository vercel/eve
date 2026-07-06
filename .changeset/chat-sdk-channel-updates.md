---
"eve": minor
---

Expand the Chat SDK channel (`chatSdkChannel`): post completed assistant messages as markdown, stream replies via post-then-edit (configurable with `streaming` and `streamingEditIntervalMs`), surface typing status on turn start and tool calls, and degrade optional adapter operations (`startTyping`, `editMessage`) gracefully when an adapter does not implement them. Add the `messageToUserContent` inbound helper and export `isNotImplemented`. The default adapter webhook route is now `/eve/v1/{adapter}`.
