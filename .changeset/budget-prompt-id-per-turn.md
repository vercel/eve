---
"eve": patch
---

Show the budget prompt again when someone sends a message after pressing Stop on it. The re-raised prompt reused the earlier prompt's request id, so `eve/client`, the Web Chat template, and the dev TUI treated it as already answered and left it unanswerable.
