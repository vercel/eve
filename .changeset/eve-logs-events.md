---
"eve": patch
---

`eve logs --events` interleaves session events (session/turn/step lifecycle, message deltas) into the diagnostic-log output, resolved at query time from the local workflow store — nothing extra is written while `eve dev` runs.
