---
"eve": patch
---

An expired session now reports its last turn to channel handlers instead of `turn_0`, and a failed session attributes the failure to the turn that was running, including after a resumed approval or a handoff. The MCP channel's `agent_get` and `agent_update` keep reporting pending input, sign-ins, and accepted answers however many events follow them, and Telegram's Authorize button opens the latest sign-in still open instead of re-sending a completed one.
