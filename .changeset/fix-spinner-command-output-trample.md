---
"eve": patch
---

Fixed transient TUI and CLI output rendering by standardizing spinners and progress rows on the shared `LiveRegion`. Streamed command output now stays aligned beneath active spinners, while failed operations preserve their command transcript for diagnostics.
