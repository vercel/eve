---
"eve": patch
---

Make `eve dev` return the terminal after one Ctrl+C or termination signal. The local server gets a bounded cleanup window before process-group termination, and interrupted sandbox cleanup resumes on the next start. A forced exit (second Ctrl+C or the shutdown backstop) now restores the terminal — raw mode, cursor, bracketed paste — before the process ends.
