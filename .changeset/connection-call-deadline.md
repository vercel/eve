---
"eve": patch
---

Connection tool calls now fail after 5 minutes without an answer, instead of holding the turn until it is cancelled. eve cancels the request and returns a tool error the agent can report, so a tool that takes longer than 5 minutes now fails. Thanks @dretanacr for reporting this in #4977.
