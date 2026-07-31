---
"eve": patch
---

Consolidate the three Vercel CLI subprocess runners onto one shared lifecycle. A `vercel` lookup killed by a signal (for example Ctrl-C during setup) now reports a cancellation failure instead of resolving as a success with truncated output.
