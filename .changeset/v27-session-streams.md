---
"eve": minor
---

Session streams now use v27 committed-fact and progress lines, with line-position cursors and event identities instead of v26 metadata; `streamControlVersion` and `streamIdleReconnectPolicy` are removed, and terminal streams emit `{"$eve":"stream.ended"}`. Checkpoints move to version 17, so sessions with an older checkpoint remain on their owning deployment instead of handing off to a v27 runtime.
