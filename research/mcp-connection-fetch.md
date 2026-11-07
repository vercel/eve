---
issue: TBD
status: proposed
last_updated: "2026-11-05"
---

# An authored `fetch` for MCP connections

## Summary

An MCP connection's HTTP traffic goes through a `fetch` eve builds and owns.
An app has no supported way to adapt a server that strays from the protocol.
For example, a server on `2026-07-28` that leaves `resultType` out of its
results fails every tool call with `Modern MCP result is missing resultType`.
The tool may have already run on the server by then. Apps work around this by
editing eve's compiled `@ai-sdk/mcp` bundle in a postinstall script, which
breaks whenever the bundle moves.

This proposes one optional field on `defineMcpClientConnection`:

```ts
export default defineMcpClientConnection({
  url: "https://mcp.example.com/mcp",
  description: "Search support cases",
  fetch: async (request, init) => normalize(await fetch(request, init)),
});
```

## Semantics

- **Last hop before the network.** eve calls the authored `fetch` in place of
  the global `fetch` for every request its MCP client sends to the server:
  discovery, `initialize`, `tools/list`, `tools/call`, the SSE stream, and the
  experimental events actions. The `Response` it returns is what the client
  reads.
- **After eve's own request shaping.** By the time eve calls it, the request
  carries the connection's `headers`, the resolved bearer token, and
  `eve-forwarded-principal` when `forwardPrincipal` is on. eve's 401 handling
  and token refresh see the authored function's response, so a rewritten
  response still drives sign-in.
- **`init` carries eve's options.** Forwarded-principal requests set
  `redirect: "error"` in `init`. An authored function that forwards `init`
  keeps that guarantee. One that drops it takes over the redirect decision.
- **Type is the platform's `fetch`.** It is a web standard, not a third-party
  API, so exposing it doesn't tie eve's public surface to `@ai-sdk/mcp`.
- **Static and dynamic connections.** Both accept it. Build-time validation
  rejects a value that isn't a function.

Out of scope: authorization endpoints (`getToken`, OAuth discovery), which
belong to the auth provider, and OpenAPI connections, which can follow if
there is demand.

## Alternatives

- **Fix each deviation in eve.** Leniency for one server's bug is a policy
  call for the MCP client, and the next deviation would need another release.
- **A response-only hook (`normalizeResponse`).** This is narrower, but it
  can't route through a proxy or record requests. `fetch` covers it with no
  extra concept.
