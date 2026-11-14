---
"eve": patch
---

Sessions run in process are kept on a Workflow World as they run, internally, through one actor per session, and continue in another process on the same World: a turn a crash cut off goes on from its last step, a subagent's run goes on with the session it opened, and any other run reports to its session as interrupted.

An answer a session splits between itself and a child reaches the child once, however often the session is restored. A runtime given a World suspends its sessions when it's disposed instead of ending them. One process writes a session at a time, and the process that ran it before stops writing once another continues it. In-process runtimes can say when everything waits, drain to a step boundary, and start a session under an id its World already holds, and a session's records carry a format version that a load migrates forward. Sessions on Workflow behave as before.
