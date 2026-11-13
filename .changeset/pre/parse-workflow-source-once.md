---
"eve": patch
---

Speed up `eve build` and `eve dev` by parsing each workflow source once and, when eve is installed, reusing eve's own workflow driver bundle across builds.
