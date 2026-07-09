---
"eve": patch
---

Channel event handlers can now subscribe to parent `subagent.called` and `subagent.completed` events, letting built-in and custom channels update native threads when delegated child work starts or finishes.
