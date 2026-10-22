---
"eve": patch
---

eve now runs every sandbox provider, including `DefaultSandbox`, directly on the public `defineSandboxProvider()` contract. Custom providers see one lifecycle change: eve calls `connection.close()` when the step that opened the connection ends, whether a turn's step, a `"use step"` function, or an `invokeTool` call, and the next step resumes the sandbox through a new connection. Server shutdown now stops only connections eve still holds: any connection mid-step, and between steps a connection without `close()`. A provider that defines `close()` and runs remote compute should bound idle compute itself, for example with an idle timeout.
