---
"eve": minor
---

Client `data` is now the conversation, with native `tool` and `interaction` parts instead of AI SDK `dynamic-tool` states; `toolResultFrom` accepts a settled call row. Custom reducers and the `EveAgentReducer`, `conversationReducer`, `defaultMessageReducer`, and `toolCallState` exports are removed: derive state from `view` or `events`, read saved events with `conversationOf(events)`, and replace `transcriptReducer(options)` with `transcriptOf(events, options)`.
