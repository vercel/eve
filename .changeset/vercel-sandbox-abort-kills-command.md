---
"eve": patch
---

On Vercel Sandbox, aborting a `sandbox.run()` or `sandbox.spawn()` command after it starts now kills it, and `run()` rejects instead of waiting, as the `abortSignal` option documents. Before, the command kept running until it exited by itself, including after a turn was cancelled. Thanks @voidhrithik for reporting this in #5301.
