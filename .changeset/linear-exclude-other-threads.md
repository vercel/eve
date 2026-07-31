---
"eve": patch
---

linearChannel: keep other agents' conversations out of the model-visible turn on multi-agent Linear issues. A new `excludeOtherThreads` option strips Linear's `<other-thread>` blocks from the default turn message (failing closed on malformed markup), and `onAgentSession` can now return `message` and `previousComments` overrides for the dispatched turn.
