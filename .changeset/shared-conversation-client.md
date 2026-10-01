---
"eve": minor
---

Frontend hooks and `EveAgentStore` now share one conversation client: default hooks return `ConversationState` (messages plus root turns, input requests, tasks, and agent sessions) instead of `EveMessageData`, and every snapshot exposes canonical `conversation` alongside a custom reducer's `data`. Answers to open input requests are accepted while a turn runs, `followSubagents: true` follows each agent tool's session into `conversation.agents`, a held turn stays `streaming` with `turns[turnId].waiting` set, and `EveAgentStore` adds a `client` option plus `compact()`, `clear()`, and `retire()`.
