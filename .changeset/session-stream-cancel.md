---
"eve": patch
---

Stop reading a session's events as soon as a channel stops iterating `session.stream()`, even while it waits for the next event.

Before, a stream a client disconnected from kept polling the session until its next event, which for an idle session never came.
