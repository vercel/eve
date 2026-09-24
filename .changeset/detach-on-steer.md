---
"eve": patch
---

In an interactive root session, a steering message that arrives while the turn waits on subagent calls or workflow tools now moves those calls to the background and answers the message right away: the calls return receipts, the stream emits `task.detached` for each, and their results arrive together in one later `task.result` message. A message that answers a pending question still answers it, `dismissible` questions resolve as `dismissed` first, and `turnPolicy: "queue"` keeps the turn waiting. `detach: { timeout }` on a workflow tool now also detaches a call still working after that many milliseconds, and in any session a steering message ends a waited `sleep` early with the time it waited.
