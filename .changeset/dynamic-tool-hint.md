---
"eve": patch
---

When a dynamic resolver adds a deferred tool or subagent mid-session, eve now appends a short message with its name, so the model knows it was added. The message omits descriptions and signatures to keep deferred entries cheap; the model searches the exact name with `eve__search` to learn them.
