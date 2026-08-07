---
issue: "883"
status: implemented
last_updated: "2026-08-08"
---

# Native MCP agent channel

## Outcome

eve exposes an opt-in `mcpChannel()` for MCP hosts that need to delegate durable work to an eve
agent. The first release publishes one agent-invocation lifecycle. It does not republish authored
tools, skills, instructions, connections, or subagents.

```ts title="agent/channels/mcp.ts"
import { localDev, vercelOidc } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth: [vercelOidc(), localDev()],
});
```

The endpoint provides four compatibility tools:

- `agent_start` creates one task-mode durable session and returns its invocation ID only after the
  session is readable.
- `agent_get` projects working, input-required, authorization-required, and terminal state without
  starting work.
- `agent_update` answers pending input requests through the session's durable continuation.
- `agent_cancel` requests terminal cancellation and is safe to repeat.

MCP Tasks and selective direct publication of authored capabilities remain follow-ups over the same
invocation service.

## Boundaries and data flow

```text
MCP request
  -> route auth and HTTP admission
  -> stateless MCP transport
  -> protocol-neutral invocation service
  -> durable eve session and workflow world
```

The MCP adapter owns protocol negotiation, schemas, and JSON-RPC errors. The invocation service owns
lifecycle projection and principal authorization. The workflow-backed execution adapter owns the
mapping to session creation, event replay, input delivery, and cancellation.

The HTTP endpoint is stateless even though the delegated work is durable. Reads reconnect through
the workflow world; they do not rely on process-local MCP sessions.

## Authentication and ownership

`auth` is required. Authors must use `none()` to opt into public access explicitly. Existing eve
route-auth functions produce the `SessionAuthContext` used by every lifecycle operation.

OAuth mode adds Protected Resource Metadata and bearer challenges, but eve remains only the OAuth
resource server. Authorization, token issuance, registration, PKCE, and refresh-token policy belong
to the configured provider.

Each invocation's searchable owner attribute stores only a SHA-256 key derived from the
authenticated principal tuple. As with other authenticated eve sessions, the token-free
`SessionAuthContext` remains in the durable session context so the workflow can enforce identity;
bearer credentials are never persisted. Every read, update, and cancel recomputes the owner key, so
an invocation ID alone is not authority.

Deployment Protection is a separate edge layer. Generic MCP OAuth is supported only where the MCP
resource can return its own challenge, or where a trusted gateway forwards a short-lived verified
identity assertion to the private origin.

## Protocol compatibility

MCP `2026-07-28` stateless requests are the target. The adapter temporarily accepts the `2025-11-25`,
`2025-06-18`, and `2025-03-26` Streamable HTTP negotiation shapes because current external hosts do
not move in lockstep. This is a deliberate interoperability exception to eve's normal pre-1.0 rule
against legacy fallback logic: all eras share one tool surface and invocation state machine, and no
legacy state is retained in eve sessions. Remove an era once the supported client matrix no longer
requires it.

Request admission enforces canonical Host/port matching, JSON and event-stream media types, and a
4 MiB body limit before compatibility inspection. OAuth metadata routes participate in the same
compile-time method/path collision checks as every other channel route.

## Durable invariants

- A status read never starts work.
- Creation is not automatically retried after an ambiguous failure.
- An invocation is readable before its handle is returned.
- Every operation authenticates and authorizes independently.
- Input updates and cancellation are accepted at most once by the durable session hook; repeat
  requests observe the accepted receipt or terminal state.
- Bearer and refresh tokens never enter workflow state.
- No authored capability is exposed implicitly.
- Compatibility tools and future Tasks adapters share one invocation service.

## Verification

The implementation is covered at the narrowest useful tiers:

- unit tests for schemas, protocol errors, request limits, state projection, ownership, auth
  challenges, metadata derivation, and update/cancel retries;
- integration tests for route collision rejection and workflow-backed invocation behavior;
- a deterministic scenario fixture that starts a real Nitro endpoint, exercises modern and legacy
  MCP requests, completes an input-required round trip, rejects a second principal, and cancels a
  separate invocation.

Manual hosted-client and Deployment Protection matrices remain release validation rather than unit
or scenario assertions.
