---
"eve": patch
---

Keep a session open when its requests outgrow the compaction threshold or the model's context window.

When the agent's instructions, tools, memory, and context leave no room under `compaction.threshold`, eve logs a warning and compacts against the model's context window instead of ending the session with `COMPACTION_FAILED`. When they don't fit the window either, only the turn fails with `COMPACTION_FAILED`. When a provider rejects a request as longer than the model's context window, only the turn fails with `MODEL_CALL_FAILED`, and the session can receive another message.

Thanks @zackleman for reporting this in #5921.
