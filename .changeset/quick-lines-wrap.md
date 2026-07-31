---
"eve": patch
---

Terminal text wrapping in the dev TUI is now linear-time, so views rendering large single-line payloads (long tool results, big JSON) no longer stall on every repaint.
