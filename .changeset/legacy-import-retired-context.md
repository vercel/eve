---
"eve": patch
---

A session started before eve 0.57 now imports on its next message instead of failing with `IncompatibleStateLayoutError` for `eve.mode`. The import drops the framework context keys that those builds saved and the current build no longer defines. Thanks @sunlanchang for reporting this in #5213.
