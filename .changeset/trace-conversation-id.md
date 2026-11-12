---
"eve": minor
---

`otel({ conversationId })` sets the `gen_ai.conversation.id` that eve's spans record from each step's caller, such as your app's own thread ID, without changing the AI Gateway session ID or anything sent to the model.

When a step keeps a running turn's caller, such as another person's approval, the turn keeps its conversation ID. A resolver that returns nothing, returns an invalid ID, or throws keeps the current ID.

Thanks @zackleman for reporting this in #5932.
