---
"eve": patch
---

`eve dev` now writes stderr and workflow diagnostics to a private per-process log under `.eve/logs/`. Long stderr output collapses to a one-line summary pointing at the log file (the raw text stays available in the `all` log mode), and error details reference the log instead of flooding the transcript.
