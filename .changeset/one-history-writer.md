---
"eve": patch
---

Session history now changes in one place, which checks every message as it joins.

A turn that fails after the model delivered its structured reply keeps that reply in history instead of an unanswered `eve__reply` call.
