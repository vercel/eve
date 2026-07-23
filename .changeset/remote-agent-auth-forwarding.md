---
"eve": patch
---

Remote agents can now forward the end user's identity across deployments. `defineRemoteAgent({ forwardAuth: true })` sends the dispatching turn's session principal (metadata only — never tokens) on the create-session request, and the receiving deployment opts in with `eveChannel({ acceptForwardedAuth })`, a predicate over the verified transport caller. Accepted forwarding replaces the session principal so per-user connections, local subagents, and chained remote hops see the original user; mismatches fail loud at the hop (403 / failed dispatch) instead of silently downgrading to the calling service's identity.
