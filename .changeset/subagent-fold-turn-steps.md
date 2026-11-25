---
"eve": patch
---

Eliminate `startTaskToolCallsStep` by returning `pausedAtMs` from `turnStep`, and fold immediate `publishDispatchedCallsStep` and waking task-reply `applyRunMessagesStep` commits into the next `turnStep`.
