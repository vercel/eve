---
issue: https://github.com/vercel/eve/pull/4855
status: in-progress
last_updated: "2026-10-23"
---

# Recursive session following

Stacked on #4855, which now includes #5281. Nested activity should not require an
application-owned recursive reducer. Observation does not establish execution completeness or grant
commands on descendants.

## Authoring contract

```ts
new SessionStore({
  followAgents: ({ depth }) => depth <= 3,
});
```

`followAgents` accepts a boolean or synchronous predicate over depth, name,
session ID, and opening owner. Omitted/false disables following; true equals an
always-true predicate. This deliberately replaces #4855's direct-agent-only true
semantics before merge. Predicates are evaluated once per committed relationship
at each known reachable depth; rejected paths are not expanded. Authorized aliases
share projections without losing either path's depth-dependent selection. Bindings share the store implementation.

## Observations and bounds

Reuse `agents[sessionId].observation.conversation.agents` at each depth. Opening
ownership remains independent of subsequent deliveries. Each followed observation
exposes its scoped key, committed line position, and whether it reached the tail
captured on its read. Call/delivery settlement remains authoritative for results.
There is no causal-completion or full-tree barrier. Root callbacks and commands
retain their existing meaning; child failures retain committed data locally.

Fixed limits: depth 8, 128 admitted observations per root generation, and 8
concurrent descendant requests independent of the root. Finite reads and ten-second
request leases provide fair scheduling. Idle reads refresh after 1–10 seconds;
retry backoff releases request slots. Exclusions remain visible with reasons.

## Reader authority and lifetime

Each path carries child IDs and the source-line coordinates of their openings.
The server reads those committed lines and verifies each relationship, never
fetching an event-supplied URL. Local hops retain their reader namespace; remote
hops proxy the remaining path with current server-owned credentials. The server
establishes identity; equal bare IDs across remote namespaces are not aliases.
Remote redirects are rejected. A path contains at most eight hops, and resolution
has a ten-second deadline.

`store.observe()` opens a reference-counted programmatic scope. Its cleanup,
framework unmount, and root replacement stop transports without cancelling work.
A new principal requires a new store. Archives remain application-owned observed
prefixes with independent cursors, not serializable native views or exhaustive audits.
