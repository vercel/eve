---
"eve": patch
---

Finish refused approval-response deliveries without leaving clients streaming, and let the dev TUI retry refused approvals. The default reducer now keeps approval, question, and session-limit prompts pending until server confirmation; frontends should disable response controls while the store is `submitted`, `streaming`, or `resuming` instead of relying on the prompt disappearing immediately.
