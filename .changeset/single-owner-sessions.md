---
"eve": minor
---

Run every conversational turn directly inside the session's owning workflow instead of dispatching a child turn run per message. An idle session now hands its settled checkpoint and complete hook set to the exact deployment that accepted a new delivery, keeping the original session id and event stream. Sessions created under the previous execution model cannot be resumed; start a new session after upgrading.
