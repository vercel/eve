---
"eve": patch
"@vercel/agent-runs": patch
---

Update eve's bundled dependencies, including the AI SDK, Vercel SDKs, Chat SDK, and MCP, to their latest releases, and OpenTelemetry to its latest 2.x releases.

eve now requires `ai` 7.0.172 or later.

YAML frontmatter, eval data files, and OpenAPI specs now parse with js-yaml 5 and YAML 1.2 values. An unquoted date such as `2024-01-02` loads as a string instead of a `Date`, and a `0b` binary literal such as `0b101` loads as a string instead of a number. The YAML 1.1 tags `!!timestamp`, `!!binary`, `!!set`, `!!omap`, and `!!pairs` are no longer recognized, and a mapping with a non-scalar key, such as `? [a]`, throws. `<<` merge keys still work.

MCP connections over Streamable HTTP now fail when the `server/discover` request fails before the server answers, instead of retrying with `initialize`. Set `protocolVersionDiscovery: false` for a server that can't handle that request. Servers that answer `server/discover` with a JSON-RPC error or an HTTP error status other than `401` still use `initialize`, and servers that reject the protocol version with a supported legacy version still negotiate it.
