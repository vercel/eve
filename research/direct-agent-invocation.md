---
issue: https://github.com/vercel/eve/issues/393
status: implemented
last_updated: "2026-08-26"
---

# Direct agent invocation and per-turn routing

## Summary

Applications and channels can select a statically declared local descendant without asking the root model to delegate. One root-relative `agent` selector is shared by the eve HTTP API, TypeScript client, fixed sessions, channel sends, and cross-channel sends.

```ts
await client.sessions.create({
  agent: "researcher",
  message: "Investigate this report.",
});

await session.send("Audit this turn.", {
  agent: "researcher/critic",
});
```

A selector on session creation makes that descendant the session default. A selector on an existing session applies to one turn; the next unqualified message returns to the session default.

## Public contract

`agent?: string` is accepted by:

- `POST /eve/v1/session` and message bodies sent to `POST /eve/v1/session/:sessionId`.
- `client.sessions.create(...)` and `ClientSession.send(...)`.
- Fixed `Session.send(...)` handles.
- `ChannelSendOptions`, proactive channel `receive` input, and cross-channel `to(...).send(...)`.

Paths use runtime-visible root-relative names. `researcher/critic` walks nested subagent directories; `crm__reviewer/auditor` retains an extension mount namespace. Every segment must resolve through the compiled static-local graph. Malformed, dynamic, remote, and missing targets fail before the turn is accepted.

`agent` cannot accompany `inputResponses`. HITL responses and authorization callbacks resume the agent that requested them without another selector.

The eve channel exposes the normalized requested path as `ctx.eve.agent` to `onMessage`. Existing route or platform authentication covers every descendant; direct invocation does not add another allowlist.

## Session semantics

A directly selected turn keeps the existing session ID, continuation address, auth, channel state, and model history. The selected node supplies its own model, instructions, tools, skills, hooks, connections, sandbox, and nested subagents. Its assistant and tool history becomes part of the shared session history, so the session default sees it afterward. A one-turn override does not replay the target's `initialMessages`.

Direct selection is routing, not delegation. It emits the ordinary events for the selected turn through the existing session stream and channel event handlers, with no synthetic `subagent.called` or `subagent.completed`. Nested delegation from the selected node still emits the normal subagent lifecycle events.

```text
public agent path
      │
      ▼
static graph resolver ──reject──▶ malformed / missing / dynamic / remote
      │ nodeId
      ▼
session inbox delivery ──partition by nodeId──▶ turn workflow
                                                │
                           load selected bundle │ preserve shared history
                                                ▼
                                      ordinary session stream
```

## Runtime boundary

One resolver walks `subagentsByName` and returns a normalized path plus an internal node ID. Public boundaries carry the path; durable session commands carry only the node ID.

Targeted creates construct the existing workflow runtime with that node ID. Existing-session sends encode the node ID in session-inbox wire version 2; version 1 payloads migrate as unqualified deliveries. Buffered messages batch only when they select the same node. Steering retains the selected target on the replacement turn.

The turn workflow loads the selected compiled bundle and refreshes the active model surface while preserving durable session history. It restores the session's original bundle before returning state to the driver. Pending HITL and authorization state records the selected node until the request settles or the turn is cancelled.

Sandbox snapshots are stored by resolved sandbox owner. Alternating root and descendant turns therefore preserve independent sandbox state, while a descendant configured with `parent.sandbox` shares its owner's snapshot.

Root session `operationId` derivation remains byte-for-byte unchanged. A targeted create uses a separate identity domain that includes the normalized path, so the same operation ID cannot alias root and descendant sessions.

## Error contract

The shared resolver raises `AgentTargetError` with one stable code:

| Code                           | HTTP status | Meaning                                        |
| ------------------------------ | ----------- | ---------------------------------------------- |
| `invalid_agent_path`           | `400`       | The path is empty, malformed, or not relative. |
| `agent_not_directly_invocable` | `400`       | A path segment is dynamic or remote.           |
| `agent_not_found`              | `404`       | A static segment is missing from the graph.    |

eve HTTP routes serialize the code before accepting the turn. Channel APIs throw the same typed error with an actionable message.

## Verification

Unit coverage owns parsing, client serialization, resolver failures, operation identity, delivery partitioning, wire migration, pending-agent recovery, and sandbox ownership. Scenario coverage exercises root → researcher → root history, targeted defaults, nested paths, stable session identity, channel event flow, and rejection cases. The `agent-subagents` E2E fixture covers raw HTTP creates and follow-ups, TypeScript client parity, custom channel dispatch, nested paths, and stable failure responses.
