---
"eve": patch
---

Failed session and task callback attempts now emit error-level logs with HTTP status or transport failure, a token-redacted destination, and available call, task, and session identifiers. Workflow retries are unchanged; best-effort activity failures keep their single warning.
