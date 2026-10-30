---
"eve": patch
---

Session history now changes in one place, which checks every message as it joins, and under `eve dev` fails a step whose tool results don't follow the calls they answer.

A turn that fails after the model delivered its structured reply keeps that reply in history instead of an unanswered `eve__reply` call. A compaction whose summary model fails to resolve now appears on the stream as a failed compaction instead of failing the turn before it starts.
