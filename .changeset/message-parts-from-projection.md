---
"eve": minor
---

`defaultMessageReducer()` now folds the session projection alongside its messages, and each tool part's `state` comes from that projection, the same call lifecycle `toolCallState` and every other eve reader use. `EveMessageData` therefore carries the projection's fields (`turns`, `inputs`, `calls`, and the rest); start from `reducer.initial()` rather than `{ messages: [] }`. A withdrawn approval now shows `output-denied` instead of an `output-available` part with a `{ status }` output, and a tool result marked `isError` shows `output-error`.
