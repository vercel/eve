---
"eve": patch
---

Fix delays and failures in server shutdown, session streams, successor sessions, and `eve dev` startup, and start every `eve` command faster.

- A self-hosted eve server exits promptly after SIGTERM or SIGINT, including after it ran sessions.
- `session.stream()` stops reading a session's events as soon as a channel stops iterating it.
- A successor session starts its next turn at once when the run it moved from has already ended, instead of up to 10 s later.
- `eve dev` no longer fails requests that arrive during startup with a `LoadCompiledManifestError`.
- Every `eve` command starts faster by loading the inspection code for `eve remote info --url` only when that command runs.
