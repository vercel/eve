---
"eve": minor
---

Background tools can now report a delegated task's terminal result in-process via `task.send({ kind: "complete" | "fail" | "cancel", ... })`, without minting a callback URL.
