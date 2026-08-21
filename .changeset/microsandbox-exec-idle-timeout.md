---
"eve": patch
---

Add an idle-timeout backstop to the microsandbox exec stream so a stalled command can no longer hang the agent turn forever. If the exec iterator stops yielding output and never delivers an `exited` event, eve now kills the command and surfaces a failure once the stream has been idle past a configurable ceiling (default 5 minutes; reset on any output, overridable via `EVE_MICROSANDBOX_EXEC_IDLE_TIMEOUT_MS`).
