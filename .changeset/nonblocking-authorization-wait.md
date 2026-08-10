---
"eve": patch
---

Conversation sessions no longer stall while an interactive authorization challenge is open: ordinary messages run as normal turns, while tasks defer unrelated input until their blocked authorization completes. Callbacks are bound to the exact challenge attempt and initiating connection principal, remain live across parked activity, and start a valid callback turn after the authorization park closes its boundary. Session timeouts are also honored during an open challenge, and `client.fetch` preserves query strings embedded in the request path.
