---
"eve": patch
---

Remote agents can now forward the end user's identity across deployments. `defineRemoteAgent({ forwardPrincipal: true })` sends the dispatching turn's session principal (metadata only — never tokens) on the create-session request, and the receiving deployment opts in with `eveChannel({ acceptPrincipalFrom })`, a predicate over the verified transport forwarder. Accepted forwarding replaces the session principal so per-user connections, local subagents, and chained remote hops see the original user; a receiver that refuses the forwarder (or accepts no forwarded principal) rejects with 403 and the dispatch fails instead of silently downgrading to the calling service's identity.
