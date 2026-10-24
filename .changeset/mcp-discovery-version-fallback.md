---
"eve": patch
---

MCP connections now fall back to the highest mutually supported legacy protocol version when `server/discover` returns `-32022`. Thanks @zico-io for reporting this in #4406, and @bluepegasus123 for proposing the fallback.
