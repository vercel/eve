---
"eve": patch
---

eve now defaults to `openai/gpt-6-luna-fast` with high reasoning when no model is configured, including newly initialized agents; explicit model and reasoning selections remain unchanged. The terminal UI shows compact model labels with dot-separated reasoning and a `⚡︎` speed marker in place of a trailing `-fast` suffix.
