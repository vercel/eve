---
"eve": patch
---

`eve build` now reports why an extension mount failed to resolve, for example an extension that requires an unsupported tool contract or a package that isn't installed. Before, the build stopped with `Selected module binding "extensions/<name>.ts" has no compile or runtime usage.` and hid the cause.
