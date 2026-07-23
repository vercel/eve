---
"eve": patch
---

The `eve dev` TUI now parks the terminal's hardware cursor on the prompt's caret cell after every repaint, so IME composition (pre-edit) text — e.g. Chinese, Japanese, or Korean input — renders inline in the input box instead of staying invisible until committed.
