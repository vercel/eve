---
"eve": minor
---

Client `messages` now show only the session's current conversation, so messages from before a clear no longer appear.

`messages` and `transcriptOf()` follow each turn's `follows` and a completed context change's `selects`, as `conversation(view)` does, and leave out turns outside the conversation. The session `view` still holds every retained turn.
