---
"eve": patch
---

The MCP channel now bounds every request: bodies over 1 MiB receive a JSON-RPC `413` before the transport reads them, and `agent_start.message` (64 KiB), input-response `text` (16 KiB), IDs (256 chars), and responses per update (64) are validated before any session is created.
