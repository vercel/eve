---
"eve": patch
---

User-role instructions, static and dynamic, now join the conversation the same way: once ahead of the next turn's input, again when their content changes, and again after a compaction or clear removes them from the history.

A newer deployment that changes a static user-role instruction adds the new text to existing sessions instead of keeping the text the session started with. Sessions that already hold an instruction don't receive it twice.
