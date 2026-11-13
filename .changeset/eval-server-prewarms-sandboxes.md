---
"eve": patch
---

`eve eval` starts the sandbox template preparation when its server boots, so template builds overlap evals that do not use a sandbox instead of stalling the first eval that does.
