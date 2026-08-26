---
"eve": patch
---

Run built-in `bash` commands in the foreground for 30 seconds by default, with an optional `yieldTimeMs` override. Commands still running then continue in the background and return a process id that the model can pass back to `bash` to poll, wait for up to five minutes by default, or kill; results also report wall time.
