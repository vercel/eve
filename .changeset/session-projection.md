---
"eve": minor
---

`ConversationState` now carries the session projection eve folds on the server and in every client: besides turns, inputs, and tasks it records each call and sign-in, with `calls`, `authorizations`, `candidates`, and `nextSequence`. Code that builds a `ConversationState` by hand needs those fields; `initialConversationState()` provides them.
