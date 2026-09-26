---
"eve": minor
---

Authorization parts now distinguish a required grant from a callback-backed grant parked at a session boundary. Frontend bindings expose canonical `conversation` state alongside a custom reducer's `data`, so authorization settlement and child following work with custom views. The eve dev terminal renders tools, child progress, and authorization from shared conversation snapshots; terminal cancellation waits for a turn ID before sending a guarded request.
