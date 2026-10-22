---
"eve": patch
---

eve now runs every sandbox provider, including `DefaultSandbox`, directly on the public `defineSandboxProvider()` contract. Custom providers see one lifecycle change: eve calls `connection.close()` when the step that opened the connection ends, whether a turn's step, a `"use step"` function, or an `invokeTool` call, and the next step resumes the sandbox through a new connection. Connections without `close()` are unaffected, and server shutdown still stops them.
