---
"eve": patch
---

The model no longer sees an "awaiting approval" note in history after the approval it describes is answered or dropped, because eve now tells each model call about pending approvals from the session's current state instead of writing a note into history when the call parks.
