---
"eve": patch
---

A Slack mention or DM reaches its session sooner: the session starts while Slack is still confirming the "Thinking..." status, and a mention that starts its thread no longer fetches the thread to look for earlier files.

A custom `received` renderer for a mention or DM now runs alongside the session start, so it can finish after the turn's output.
