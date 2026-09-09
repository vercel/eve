---
"eve": patch
---

Add `from(address).create()` for application code that needs to reserve a channel address before sending its first message. An idle session has normal identity and channel configuration, but does not start a model turn until its fixed session handle sends a message.
