---
"eve": patch
---

`eve dev` no longer floods startup with spurious Node 24 "File descriptor … opened/closed in unmanaged mode" warnings. The dev build worker now disables unmanaged-fd tracking, which it never relied on.
