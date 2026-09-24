---
"eve": patch
---

`mcpCapabilitiesChannel` accepts `trustedForwarders`, so a trusted calling agent can run tools on behalf of its user by sending an `eve-forwarded-principal` header (build it with `encodeForwardedPrincipalHeader` from `eve/channels/mcp`). Tools then see the forwarded user in `ctx.session.auth`, and each forwarded user gets their own session and sandbox.
