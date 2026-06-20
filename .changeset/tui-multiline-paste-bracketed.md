---
"eve": patch
---

The dev TUI prompt now takes multi-line input in both chat and freeform `ask_question` fields. Pasting multi-line text inserts it intact instead of submitting at the first line, `Shift+Enter` inserts a newline, a tall prompt scrolls within the terminal height, and editing moves by whole graphemes so wide and emoji characters aren't split.
