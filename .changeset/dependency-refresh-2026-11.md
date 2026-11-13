---
"eve": patch
"@vercel/agent-runs": patch
---

Update eve's bundled dependencies, including the AI SDK, Vercel SDKs, Chat SDK, MCP, and OpenTelemetry, to their latest releases.

YAML frontmatter, eval data files, and OpenAPI specs now parse with js-yaml 5 and YAML 1.2 values: an unquoted date such as `2024-01-02` loads as a string instead of a `Date`, and the YAML 1.1 tags `!!timestamp`, `!!binary`, `!!set`, `!!omap`, and `!!pairs` are no longer recognized. `<<` merge keys still work.

MCP connections over Streamable HTTP now fail when the `server/discover` request fails at the transport level, instead of retrying with `initialize`. Servers that answer `server/discover` with a JSON-RPC error or an HTTP 4xx still use `initialize`, and servers that reject the protocol version with a supported legacy version still negotiate it.
