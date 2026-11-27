---
"eve": patch
---

`eve dev` signs every message its Workflow World sends and names the agent's queue for runs that recorded no queue namespace, so cancelling a run whose snapshot is gone no longer fails with `Workflow delivery is not trusted`, and `--resume` re-enqueues each run on the queue it recorded.
