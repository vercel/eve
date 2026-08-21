---
"eve": patch
---

Tool inputs now stream through the durable event protocol as `action.input.appended` before the matching validated `actions.requested` event. The default message reducer exposes the cumulative raw input on `dynamic-tool.inputText` while its state is `input-streaming`, so UIs can progressively render long JSON inputs. This advances the stream protocol to version 24; when assistant text precedes a tool call, `message.completed` now arrives before that call's streamed input events.
