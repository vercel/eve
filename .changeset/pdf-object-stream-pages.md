---
"eve": patch
---

PDFs that store their pages in compressed object streams, as phone scans and `pdf-lib` output usually do, now get a per-page token estimate instead of one based on file size. A multi-megabyte scan no longer requests compaction on the first step of a session. Thanks @DLME2024 for reporting this and suggesting the fix in #5090.
