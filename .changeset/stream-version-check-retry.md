---
"eve": patch
---

Reading a session started on an earlier eve no longer fails with `session_version_unsupported` when the stream route's check of its first line is slow or fails; the route now answers a retryable `503`, which eve clients retry, instead of serving the session's lines unconverted.

Thanks @jimexist for reporting this in #5778.
