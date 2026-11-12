---
"eve": patch
---

A turn whose step fails every Workflow retry now settles `failed` with code `TURN_FAILED`, a fixed message, and an error id, instead of the thrown error's class and raw message, which could carry prompt text or tool input.

eve's server log records the failure under that error id with the thrown error's class, but not its message or details.

A turn cancelled while its failing step was between retries now settles `cancelled` and keeps its input in history, instead of settling `failed` with the step's error.

Thanks @zackleman for reporting this and proposing the fix in #5915.
