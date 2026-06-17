---
"eve": patch
---

Multi-line input in the dev TUI prompt: pasting multi-line text now inserts it intact via bracketed paste (instead of truncating at the first line), and Shift+Enter / Alt+Enter insert a newline without sending. Embedded newlines show inline as `⏎` and are preserved on submit.
