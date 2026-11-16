---
"eve": patch
---

Typing in the "Project to link" picker during an integration setup, such as `/add` in `eve dev`, no longer crashes with `TypeError: n.label is not a function`.

Integration setup runs in a child process, and the IPC channel dropped the picker's search action. The child now sends the search label as text and resolves a picked search itself, so the "Search for '…'" row works there as well.
