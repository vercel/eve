---
"eve": patch
---

The Web Chat template folds the tool calls, reasoning, and subagent work between each stretch of an answer into one expandable activity line, with each call's status from `toolCallState` and a followed subagent's work nested under its call. Approvals, questions, session limits, and sign-ins, including ones a subagent passes up, appear inline where they arrived until they're answered; an answered approval stays with its batch until the agent picks the batch up.
