---
"eve": minor
---

Session streams are now version 27. Each stored line is one commit of facts (`{at, facts}`) or one progress record (`{progress}`), and a line's position is its identity, so readers resume by position and never see half a commit. eve no longer reads streams older than version 27, the `streamControlVersion` parameter and the client's `streamIdleReconnectPolicy` option are removed, and a finished session's stream ends with `{"$eve":"stream.ended"}`.
