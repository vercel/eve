---
"eve": patch
---

eve now runs every sandbox provider, including `DefaultSandbox`, directly on the public `defineSandboxProvider()` contract, and calls `connection.close()` when the step that opened a connection ends, so the next step resumes through a new connection. Server shutdown stops only connections eve still holds, so a custom provider that defines `close()` and runs remote compute should bound idle compute itself, for example with an idle timeout.
