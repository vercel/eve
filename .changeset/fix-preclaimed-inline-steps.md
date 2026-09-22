---
"eve": patch
---

Fix a Vercel Workflow race where a rejected inline-step preclaim could skip the owner's body, leaving the durable step to fail after exhausting its retry limit without running user code.
