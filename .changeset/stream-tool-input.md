---
"eve": patch
---

Tool inputs now stream through the durable event protocol as `action.input.appended` before the matching validated `actions.requested` event. Each event stores only its raw delta and UTF-16 offset, while the default message reducer exposes cumulative raw input on `dynamic-tool.inputText` in the `input-streaming` state. This advances the stream protocol to version 24; when assistant text precedes a tool call, `message.completed` now arrives before that call's streamed input events.
