---
"eve": patch
---

`eve dev` now uses a single `*` marker for completed slash commands and excludes picker and drawer commands, including `/loglevel`, from input history. Setup failures keep their invocation visible, and failed registry installs no longer expose installer output in TUI diagnostics.
