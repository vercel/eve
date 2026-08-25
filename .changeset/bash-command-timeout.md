---
"eve": patch
---

Bound built-in `bash` commands to five minutes by default and allow the model to request up to ten minutes with the optional `timeout` input. Bash deadlines now compose with turn cancellation so stalled commands are terminated before they can hold a run indefinitely.
