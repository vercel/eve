---
"eve": patch
---

A prompt that OpenAI refuses for possible cybersecurity risk (error code `cyber_policy`) now fails only its turn, and the session accepts the next message.

The refused message stays out of the conversation history. Before, the refusal's `400` status ended the session, so every later message to it was rejected with `409 session_not_active`.
