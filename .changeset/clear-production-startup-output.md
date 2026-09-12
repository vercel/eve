---
"eve": patch
---

Stop retaining server output in `eve start` after the server is ready, preventing memory growth as a long-running server writes logs. stdout and stderr continue to stream to the host's log collector.
