---
"eve": patch
---

Fix `experimental_chatgpt` sending requests in an improper format that the
Codex backend rejected with a 400 Bad Request: system instructions are now sent
in the top-level `instructions` field and the unsupported `max_output_tokens`
parameter is dropped.
