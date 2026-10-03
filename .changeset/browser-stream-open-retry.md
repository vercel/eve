---
"eve": patch
---

Retry session stream opens and reconnects when Safari, iOS browsers, or Firefox reject `fetch()` with `TypeError: Load failed` or `TypeError: NetworkError when attempting to fetch resource.`, matching the existing Chrome and Node behavior.
