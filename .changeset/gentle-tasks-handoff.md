---
"eve": patch
---

Preserve additive metadata in durable task and subagent handle state across updates. Deployment handoffs now validate retained tasks and handles and reject pending work before taking ownership, allowing the previous owner to recover if the checkpoint is incompatible.
