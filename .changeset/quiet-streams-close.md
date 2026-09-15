---
"eve": patch
---

The eve channel now ends a live session stream response after ten seconds without an event and releases its server-side reader, so client reconnects no longer leave abandoned serverless invocations running until their execution timeout. The client reconnects immediately after such a close; only connections that end abnormally count toward the idle reconnect limit and back off. The client's read-stall timeout is now derived from the server idle-close interval. Clients built from an earlier eve version still count these closes against their idle limit, so a manually opened `session.stream()` on an older frontend may stop following a quiet session after roughly fifty seconds against an upgraded server; upgrade the client alongside the server.
