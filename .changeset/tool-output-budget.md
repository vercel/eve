---
"eve": minor
---

Tool results now reach the model within a default budget of about 12,000 tokens, configurable with `limits.toolOutputTokens`, so one oversized authored or MCP result no longer fills every later request until compaction.

A result over the budget keeps its start and end around a truncation notice; oversized JSON becomes truncated text, and file parts are not counted. Channels, hooks, and `call.settled` still receive the full result, and eve's built-in tools keep their own limits. Set `limits.toolOutputTokens: false` to send every result whole, as before.

Thanks @zackleman for reporting this in #5924.
