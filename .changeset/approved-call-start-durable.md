---
"eve": patch
---

Store an approved tool call's start before the call runs, so a crash right after its side effect recovers the call as interrupted instead of running it again or reporting that it did not run.

Thanks @dretanacr for reporting this in #5841.
