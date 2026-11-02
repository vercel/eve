---
"eve": patch
---

Add `eve/extensions/btw` for asking a side question about a running task without steering or interrupting it.

`btwCommand()` is a command for `eveChannel({ commands })` or Slack's `runCommand`. It answers from the session's recorded stream, including the turn still running, with one tool-free call to the session's own model, and the eve channel shows the answer only to the caller. Nothing is delivered to the session, so its history is unchanged. `askAside(sessionId, question)` gives server code the same answer, and `answer` replaces the default model call.
