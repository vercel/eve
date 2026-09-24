---
"eve": patch
---

Follow a delegated child's activity from a client with `session.streamSubagent(called, options?)`. Pass a `subagent.called` event from that session. The client reads its `childStreamPath` with the session's host and credentials, so a remote child streams through the parent deployment's proxy route, and the child's cursor stays separate from the parent's. Eval sessions expose the same method with the eval client's credentials.
