---
"eve": patch
---

Tools published with `mcpChannel({ tools: true })` can now run as the user a trusted caller forwards. Set `trustedForwarders` on the channel to accept the `eve-forwarded-principal` header, and `forwardPrincipal: true` on a `defineMcpClientConnection` to send the turn's user to another eve agent. A channel without `trustedForwarders` refuses requests carrying the header with `403`. `invokeTool` also accepts `initiator` and `forwarder` options.
