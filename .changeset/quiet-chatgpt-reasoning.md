---
"eve": patch
---

Fix `chatgpt()` dropping reasoning summaries and emitting unsupported-reasoning warnings after tool calls. Stateless requests now preserve all summaries and their encrypted reasoning payload across model steps.
