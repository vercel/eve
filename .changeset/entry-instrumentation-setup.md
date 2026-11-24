---
"eve": patch
---

In a platform entry build, eve now registers authored instrumentation without top-level `await` and waits for its setup in the instrumentation phase of `start()`; other builds keep awaiting setup before the server loads.

`start()` from `eve:app` now refuses to run when the entry module has not imported `eve:instrumentation` first, and names that fix.
