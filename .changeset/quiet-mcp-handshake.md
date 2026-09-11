---
"eve": patch
---

Add `protocolVersionDiscovery` to MCP client connections. Set it to `false` to use the initialization handshake for servers that reject modern discovery, while keeping discovery enabled by default.
