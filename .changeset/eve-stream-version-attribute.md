---
"eve": patch
---

Determine a session's stream version from its workflow run attributes (`$eve.stream_version` and `$eve.version`) before falling back to reading line 0, avoiding full-history stream replays on cold instances.
