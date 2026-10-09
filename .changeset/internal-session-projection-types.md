---
"eve": patch
---

`eve/vue` and `eve/svelte` no longer export the internal session projection types `SessionAuthorization`, `SessionCall`, `SessionCallStatus`, and `SessionProjection`, matching `eve/react`. Use `ToolCallStatus` and `toolCallState()` to read a tool call's status.
