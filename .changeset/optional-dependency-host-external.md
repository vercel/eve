---
"eve": patch
---

Keep packages external in the server build when they only list a `build.externalDependencies` entry as an optional dependency. Listing `sharp` no longer inlines `next` with absolute build-machine paths.
