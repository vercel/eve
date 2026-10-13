---
"eve": minor
---

A client's `data` is the conversation. Custom reducers (`useEveAgent({ reducer })`, `EveAgentReducer`), `conversationReducer`, `defaultMessageReducer`, and `toolCallState` are removed: derive other state from `events`, or read saved events with `conversationOf(events)`. `transcriptReducer(options)` is now `transcriptOf(events, options)`.
