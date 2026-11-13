---
"eve": patch
---

Exit a self-hosted eve server once its in-flight requests finish after SIGTERM or SIGINT, including after it ran sessions.

Every session started over HTTP left a live read of its event stream open, so the server process stayed up after it closed and `eve start` killed it after 25 seconds. Shutdown also waited up to several seconds for clients, including Workflow's local queue, to drop keep-alive connections; the server now closes each connection as soon as its last response finishes.
