---
"eve": patch
---

`/login chatgpt` now lists current subscription models such as `gpt-6-luna`, and the default `chatgpt()` model (`gpt-6-luna-fast`) works: eve sends it to Codex as `gpt-6-luna` on the priority service tier, since Codex rejects `-fast` model IDs.
