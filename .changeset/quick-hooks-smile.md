---
"eve": patch
---

Reduce new-session startup latency by returning the session ID as soon as Workflow accepts the run instead of waiting for its command inbox. Hook claims and session initialization also start together so the first turn can begin sooner.
