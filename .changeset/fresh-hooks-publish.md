---
"eve": minor
---

Authored stream-event hook failures are now logged while remaining handlers and agent execution continue, so throwing from a hook no longer rejects a turn or session. Subagent notifications no longer run model preparation.
