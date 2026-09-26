---
"eve": patch
---

Local development now leaves previous invocations' workflows dormant by default; use `eve dev --resume` to attempt recovery, with warnings for retained runs that fail conservative startup checks. Recovery decisions last for the server invocation without changing hot-reload behavior for admitted runs, including follow-up turns, cancellation, and starting a new conversation.
