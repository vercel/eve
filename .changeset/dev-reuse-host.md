---
"eve": minor
---

Make `eve dev` agents ready sooner after a restart by reusing the previous run's development host when nothing it was built from has changed.

Each start logs whether it reused the host or why it rebuilt. Set `EVE_DEV_HOST_REUSE=0` to rebuild the host on every start.
