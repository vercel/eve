---
"eve": patch
---

`eve dev` now writes a private per-process diagnostic log under `.eve/logs/` capturing stderr, stdout (including sandbox and rebuild lines), tool failures, workflow errors, and eve framework log records (stored structured, with level, namespace, and JSON fields). The file is JSON Lines: every line is one JSON record with `at` and `source` fields. Long stderr output collapses in the transcript to a one-line summary pointing at the log file (the raw text stays available in the `all` log mode), and error details reference the log instead of flooding the transcript.
