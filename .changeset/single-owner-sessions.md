---
"eve": minor
---

Run every conversational turn directly inside the session's owning workflow instead of dispatching a child turn run per message. An idle session now hands its settled checkpoint and complete hook set to the exact deployment that accepted a new delivery, keeping the original session id and event stream. Sessions cannot hand off across the previous and current execution models in either direction; retire and restart them before upgrading or rolling back across that boundary.
