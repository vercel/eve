---
"eve": minor
---

`eve dev --no-ui` now prints `[DEV] ready at <url>` as its last startup line, once the agent is compiled and the server accepts requests, so scripts and coding agents can wait for it instead of sleeping for a fixed time.

The line replaces `[DEV] server listening at <url>`, which `eve dev` already printed at the same moment. Scripts that match the old text need to match `ready at` instead. `eve start` still prints `server listening at`. The CLI reference documents the ready line, the non-zero exit when startup fails, and how to stop the server by its process ID.
