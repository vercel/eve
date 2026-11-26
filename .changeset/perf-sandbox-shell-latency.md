---
"eve": patch
---

Speed up sandbox shell, `glob`, and `grep` execution by streaming Vercel Sandbox commands in one request, folding `glob` and `grep` probes into a single command, trimming the `bash` launcher and Docker wrapper, and running internal sandbox commands in a non-login shell.
