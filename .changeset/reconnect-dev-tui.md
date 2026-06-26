---
"eve": patch
---

Running `eve dev` interactively now reconnects to the healthy loopback dev server recorded for the same app root, with a fresh session for each attached terminal UI. Eve replaces stale or malformed state when it starts a new server. `--host`, `--port`, or `PORT` skips reconnection and reports a healthy recorded server instead.
