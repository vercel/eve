---
"eve": minor
---

eve now stops a session's sandbox once the session has been idle for 5 minutes, so a short turn no longer pays for a sandbox that runs until the provider's own timeout.

Set `idleTimeoutMs` on the sandbox environment to choose the window. `0` stops the sandbox as soon as the session goes idle, and `idleTimeoutMs: false` restores the previous behavior, where only the provider's own timeout stops it. Vercel Sandbox and Docker stop idle sandboxes, and `DefaultSandbox.environment()` takes the option at its top level. eve never starts or resumes a sandbox in order to stop it. Files persist, the next turn that uses the sandbox resumes it, and processes still running in the sandbox end with the stop. That includes a process your `defineSandbox()` definition started, such as a local server: resuming the sandbox doesn't run the definition again, so start it again from the tool that needs it, or set `idleTimeoutMs: false`. A command that the `bash` tool left running keeps the sandbox running for up to 30 minutes, and a tool can keep it running longer with `sandbox.keepRunning()`. On Docker, a session's container now stops after the window instead of running until the eve server stops.

A `turn.settled` hook that calls `ctx.getSandbox()` and `stop()` to limit sandbox cost is no longer needed. Remove it, because opening the sandbox to stop it resumes or creates the sandbox on turns that never used it.

Custom sandbox providers can implement the new optional `attach(ctx, state, { signal })` method, which connects to a sandbox only when its compute is already running. eve stops an idle sandbox through the connection it returns and aborts `signal` if that takes longer than 120 seconds. A provider without it behaves as before. eve reserves `idleTimeoutMs`, as it does `prepare`, and a provider's `environment()` doesn't receive it.
