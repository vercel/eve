---
"eve": minor
---

Slack task cards and typing indicators name work more clearly. A task the agent hands to its own copy shows its brief instead of `agent: …`. Row titles and results use the first sentence, and results are cut to about 100 characters at a word boundary. The typing indicator shows the same labels as the card and says `Waiting on 3 tasks...` instead of naming one task and counting the rest. The `describeActionRequest` and `describeActionRequests` exports from `eve/channels/slack` are removed. A renderer can call `next()` for eve's default status, or read `presentation` from `actions.requested`.
