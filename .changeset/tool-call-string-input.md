---
"eve": patch
---

Tool calls whose arguments arrive as a raw JSON string (e.g. provider-executed server tools) are now parsed, and arguments that cannot be parsed at all — such as malformed JSON emitted by the model — surface as a failed tool result the model can react to instead of failing the whole turn.
