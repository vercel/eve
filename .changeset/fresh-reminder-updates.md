---
"eve": minor
---

Add dynamic schedule updates for timing and complete payload replacement, with prepared-payload approval for model calls. Payload replacement makes the updating caller the new creator; custom schedule providers must implement `update`, and `preparePayload` now receives a `create` or `update` operation.
