---
"eve": patch
---

A message sent while a session-limit prompt waits now starts a real turn and is received right away, with `turn.started` and `message.received` before that turn's `turn.waiting`, instead of an unpaired `turn.waiting`. Answering the prompt resumes that turn without announcing the message again.
