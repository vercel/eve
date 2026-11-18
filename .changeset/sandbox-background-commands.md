---
"eve": minor
---

eve now keeps a session's sandbox running while a turn uses it and while a command that `bash` left running is still in progress, so a long job no longer ends when the sandbox's timeout or the idle stop arrives.

On Vercel Sandbox, eve extends the sandbox's `timeout` back to its full length whenever it runs a command or reads, writes, or removes a file. `timeout`, 30 minutes by default, now counts from eve's last use of the sandbox instead of from each resume, up to your plan's maximum session duration. With `idleTimeoutMs: false`, a sandbox therefore stops `timeout` after eve last used it.

A command that `bash` returns as `running` keeps the idle sandbox running until it exits, for up to the new `backgroundTimeoutMs` environment option, 30 minutes by default. Set a longer value for long jobs, or `0` to let the idle stop end the command. eve checks on the command without resuming the sandbox, and stops the sandbox within 5 minutes of the command exiting, or within `idleTimeoutMs` when that is longer. Vercel Sandbox and Docker support the option, and `DefaultSandbox.environment()` takes it at its top level.

Only a command that `bash` is still tracking counts. A process detached with `&` or `nohup` still ends with the idle stop, and the `bash` tool's description now tells the model to run a long job in the foreground of its own call.

Custom sandbox providers opt in with two optional members. `onSessionIdle()` receives `inUse(connection)`, and leaves compute running when it resolves `true`. A connection's `keepAlive({ durationMs })` extends a backend's own timer when `bash` leaves a command running. A provider without them behaves as before. eve reserves `backgroundTimeoutMs`, as it does `idleTimeoutMs`, and a provider's `environment()` doesn't receive it.
