---
"eve": minor
---

Trace each workflow `agent()` invocation as its own caller span and child trace, including parallel and background calls. Continued child sessions keep their trace while reporting the current invocation as their parent call, while model spans use client semantics and standard response and token metadata.
