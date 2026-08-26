---
"eve": patch
---

Run built-in `bash` commands in the foreground for five minutes by default, with an optional `yieldTimeMs` override. Commands still running then continue in the background and return a process id that the model can pass back to `bash` to poll, await, or kill; results report wall time and long output preserves its head and tail.
