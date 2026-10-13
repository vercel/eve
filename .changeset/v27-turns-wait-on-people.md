---
"eve": minor
---

A turn pauses only when it waits on a person: `turn.paused` names the interactions in `awaiting`, and `turn.resumed` is gone, since the next fact under the turn shows it running. A turn waiting on its own work, such as tasks, keeps running, and `eve invoke` ends a run that needs a person with one `input-required` status.
