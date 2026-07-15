---
"eve": patch
---

Session teardown now disposes authorization hooks without waiting on pending durable iterator reads, preventing cancelled sessions from hanging during cleanup.
