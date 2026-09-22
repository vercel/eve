---
issue: "905"
status: proposed
last_updated: "2026-09-21"
---

# Connection result projection

Large remote results currently enter model context in full. Applications should
be able to project predictable results without replacing eve's connection
discovery, authentication, or approval machinery.

Add `toolCall.toModelOutput`, keyed by bare remote tool or operation name, to MCP
and OpenAPI connections. The callback follows the authored-tool contract: it
projects the result sent to the model while the full remote result remains in
`action.result`, channel events, hooks, and durable session history.

Operations without a configured projection retain their current result and output
schema. Remote exceptions, MCP `isError: true` results, and non-2xx OpenAPI
responses bypass projection so the model retains the original failure details.
Authorization and approval remain unchanged.

This addresses predictable, well-structured results rather than imposing a generic
size ceiling or truncating arbitrary JSON. Reference-based retrieval of bounded
tool output remains separate work in #1040.

PR #3231 proposed the same per-operation surface. This proposal carries that
design forward with current connection lifecycle, error, durability, and end-to-end
coverage.
