---
"eve": minor
---

A tool can now keep a session's sandbox running after the session goes idle by calling `sandbox.keepRunning()`, and `bash` keeps it running for up to 30 minutes for a command it left running.

`sandbox.keepRunning({ forMs, while })` keeps the sandbox running for `forMs`, up to 24 hours, and, with the optional `while` shell command, only while that command still exits 0. eve runs the command about every 5 minutes while the session is idle or a turn waits, without resuming the sandbox, and stops the sandbox once the time is up or the command fails. The call has an effect only where eve stops the sandbox when its session goes idle, from the session that owns the sandbox, and while the sandbox runs. Elsewhere it resolves `{ until: null }` and changes nothing, for example on just-bash or a custom provider without `attach()`, with `idleTimeoutMs: false`, from a subagent that shares its parent's sandbox or a workflow tool's `"use step"` function, in an `invokeTool` call, and after `sandbox.stop()`. A command that `bash` returns as `running` keeps the sandbox running while it runs, for up to 30 minutes. A process detached with `&` or `nohup` is kept only when a tool names it in `while`.

On Vercel Sandbox, `timeout` now counts from eve's last use of the sandbox instead of from each resume, up to your plan's maximum session duration. With `idleTimeoutMs: false`, a sandbox therefore stops `timeout` after eve last used it.

Custom sandbox providers whose backend stops compute on its own timer should restart that timer on every connection operation, because eve never extends it. `connection.stop()` can receive `{ signal }`. `keepRunning` is now a member of every sandbox, so a connection's `extensions` can't define it.
