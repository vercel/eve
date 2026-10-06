---
"eve": patch
---

Approved local tools execute through eve's tool wrappers instead of AI SDK approval-history replay. Execution retains schema and authorization rechecks, concurrent siblings, the originating tool bindings, and the AI SDK's tool telemetry in the step's first attempt; approval markers are replaced by ordinary tool results before the next model call.
