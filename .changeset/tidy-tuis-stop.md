---
"eve": patch
---

Ensure exiting the dev TUI shuts down its owned server and any surviving workflow processes before the CLI exits. Persisted workflow messages now reach the ready worker during restart instead of being rejected while the file watcher starts.
