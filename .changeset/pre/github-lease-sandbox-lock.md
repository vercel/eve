---
"eve": patch
---

Subagents that share a sandbox no longer trigger spurious GitHub sign-ins when they run `gh` commands at the same time.

The `gh` tool's credential lease replaces the sandbox's network policy for the duration of one command. Leases were serialized per session, so sessions sharing a sandbox, such as parallel subagents, could replace or clear each other's credential mid-command; the stranded command got a 401 from GitHub, which asked the user to sign in again even though their grant was valid. Leases are now serialized per sandbox by a lock inside the sandbox, which works across processes. A command waits up to a minute for another to finish, then fails with a retryable error.
