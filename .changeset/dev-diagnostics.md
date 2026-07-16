---
"eve": patch
---

`eve dev` now writes a private per-process diagnostic log under `.eve/logs/` capturing stderr, stdout (including sandbox and rebuild lines), tool failures, and workflow errors. Long stderr output collapses in the transcript to a one-line summary pointing at the log file (the raw text stays available in the `all` log mode), and error details reference the log instead of flooding the transcript.
