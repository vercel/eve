---
"eve": minor
---

Session streams are now version 27. Each stored line is one commit (`{at, facts}`) or one progress record (`{progress}`), and a line's position is its identity: event ids are derived from positions, and readers resume by position. A transition's events share one line, so readers never see half of it. Streamed deltas and partial tool results are progress records. Channel handlers now run after the write and observe events without shaping them.

The stream route always sends `{"$eve":"heartbeat"}` records and leases, and ends a finished session's stream with `{"$eve":"stream.ended"}`, so readers stop on it instead of counting empty reconnects. Sessions now close their stream however they end. The `streamControlVersion` parameter, the client's `streamIdleReconnectPolicy` option, and reading streams older than version 27 are removed. A new `eve/events` entry exports the v27 event catalog, its shared fold and selectors, and guards for clients.
