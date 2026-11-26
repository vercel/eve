---
"eve": patch
---

Speed up sandbox shell, `glob`, and `grep` execution by running Vercel Sandbox `run()`, internal commands, and the bounded `bash` launcher over a single streaming request, folding `glob` and `grep` probes into one command, trimming the `bash` launcher, and running internal sandbox commands in a non-login shell.
