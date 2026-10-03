---
"eve": patch
---

`useEveAgent` no longer aborts an in-flight turn when React replays its effects during Fast Refresh or Strict Mode. Unmounting still stops the local stream.
