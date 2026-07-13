---
"eve": patch
---

Turns are now cancellable at the workflow layer: each session exposes a durable, stable cancel hook (`{sessionId}:cancel`), and resuming it mid-turn aborts the in-flight model, tool, and subagent-wait work in real time. The payload's optional `turnId` scopes the cancel to the turn the caller observed. A cancelled turn settles as a new `turn.cancelled` stream event followed by `session.waiting` — never as a failure — keeps whatever it streamed before the abort, discards pending subagent dispatch and HITL routing state, and leaves the session ready for the next message (stream version 19). Channels can handle `turn.cancelled` in their `events` map, authored stream-event hooks fire for it, and `eve/client` finalizes partially streamed messages on cancellation. No public trigger exists yet; the HTTP cancellation API ships in a following release.
