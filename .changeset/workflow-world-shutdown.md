---
"eve": patch
---

Self-hosted eve servers now close their Workflow world on shutdown, so a pending workflow `sleep` or delivery retry no longer holds the process open until the supervisor kills it.

If closing the world fails, eve logs the error and still runs the rest of its shutdown, including sandbox shutdown and the final trace flush.
