---
"eve": patch
---

Fix `eve dev` silently stopping session updates during long periods of background work. The terminal now keeps listening while the prompt is open, so completion reports appear without another user message.
