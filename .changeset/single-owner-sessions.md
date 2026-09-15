---
"eve": minor
---

Run every conversational turn directly inside the session's owning workflow instead of dispatching a child turn run per message. An idle session hands its settled state to the exact deployment that accepted a new delivery, whether the delivery arrives through the session ID or any channel continuation address, keeping the original session ID and event stream and renewing the session's configured timeout. Deliveries that land while a handoff is in progress wait for the successor instead of starting a replacement session.

Steering a running turn applies at the next committed step boundary without cancelling in-flight model or tool work and preserves the turn's identity and usage; input that arrives after the model has answered starts the next turn. `continuation.rekey()` is replaced by `continuation.alias()`: every claimed address stays active, and the most recently selected alias is exposed as `continuation.token`.

Sessions from the former driver/turn execution model are imported on their next turn, preserving identity, history, and the original stream while interrupting pending work; drivers started before eve 0.45 are reported inactive and their channel starts a fresh session. Retain the original deployment until imported sessions end, and retire sessions before rolling back across this boundary.
