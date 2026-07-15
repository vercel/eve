---
"eve": patch
---

Turns are now cancellable: resuming a session's durable cancel hook (`{sessionId}:cancel`, with an optional `turnId` guard) aborts in-flight work and settles the turn as a new `turn.cancelled` stream event followed by `session.waiting` — never as a failure. Channels and stream-event hooks can handle `turn.cancelled`, and `eve/client` finalizes partially streamed messages. The HTTP cancellation API ships in a following release.
