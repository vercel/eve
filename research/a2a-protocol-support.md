---
issue: TBD
status: proposed
last_updated: "2026-09-02"
---

# A2A protocol support

## Summary

Agent2Agent (A2A) is an open protocol, now stewarded by the Linux Foundation's Agentic AI
Foundation, for one agent to delegate work to another opaque agent. Version 1.0 is released. Its
model is small: a client discovers an **Agent Card** at `/.well-known/agent-card.json`, sends a
**Message** and receives a **Task** that moves through a fixed lifecycle
(`SUBMITTED → WORKING → INPUT_REQUIRED | AUTH_REQUIRED → COMPLETED | FAILED | CANCELED | REJECTED`),
and reads results as **Artifacts**. Tasks are grouped by an optional `contextId`. Three wire
bindings (JSON-RPC, gRPC, HTTP+JSON) are functionally equivalent; JSON-RPC over HTTP with SSE
streaming is the one every SDK ships first.

The opinion this document forms:

1. **A2A is an agent protocol, not a tool protocol.** It exposes one ability (send a message, get a
   task) rather than a tool list. eve already has the right abstraction for that: a subagent.
   Consuming an A2A agent should be `defineA2AAgent` under `agent/subagents/`, lowered to a
   background subagent tool exactly like `defineRemoteAgent`. It should **not** be a connection;
   a connection would surface a single `send_message` tool with worse semantics than the subagent
   path eve already has (durable park, callbacks, follow-ups, cancellation).

2. **Serving A2A is a channel, and it is a thin binding over a kernel eve already has.**
   `WorkflowAgentInvocationExecution` (`internal/invocation/`) already projects a task-mode
   session as `working | input_required | authorization_required | completed | failed | cancelled`
   with an owner key, a poll hint, structured input requests, and a result. That is the A2A task
   model one rename away. The MCP channel is the first binding over that kernel; `a2aChannel`
   is the second. This keeps the core lean and gives eve a real "protocol-neutral invocation"
   story: MCP and A2A are two ways to address the same durable task.

3. **Ship JSON-RPC 1.0 only, with streaming, without push notifications, without 0.3 compat.**
   One POST route plus the well-known card. Streaming is cheap because eve's event stream is
   already durable and resumable; push notifications and card signatures add SSRF/retry and JWS
   surface that v1 does not need. Pre-1.0 eve does not carry a legacy binding.

4. **Task = task-mode session in v1; `contextId` continuity waits for immutable tasks.** The
   tools-as-tasks work (`research/tools-as-tasks.md`) already aligns eve's future task model with
   A2A's "immutable task inside a longer-lived context". Until that lands, v1 sets
   `contextId = taskId` and rejects client-supplied `contextId` values it does not know, which the
   spec permits. Serving conversational contexts (`contextId` = eve session, `taskId` = eve turn)
   is the first follow-up, not a v1 blocker.

```text
                 eve as A2A client                          eve as A2A server
 ┌─────────────────────────────────────┐        ┌──────────────────────────────────────┐
 │ agent/subagents/researcher.ts       │        │ agent/channels/a2a.ts                │
 │   defineA2AAgent({ url, ... })      │        │   a2aChannel({ auth, card? })        │
 │            │ lowered to subagent    │        │            │                         │
 │            ▼ tool (background)      │        │  GET  /.well-known/agent-card.json   │
 │  A2A JSON-RPC client                │──────▶ │  POST /eve/v1/a2a   (JSON-RPC + SSE) │
 │   SendMessage(returnImmediately)    │        │            │                         │
 │   GetTask poll (durable sleep)      │◀────── │  WorkflowAgentInvocationExecution    │
 │   CancelTask on parent cancel       │        │   task-mode session ⇄ A2A Task       │
 └─────────────────────────────────────┘        └──────────────────────────────────────┘
```

## Protocol facts that shape the design

- **Blocking by default.** `SendMessage` MUST wait for a terminal or interrupted state unless
  `configuration.returnImmediately: true`. Serverless hosts bound request duration, so a server
  needs a deadline and a client should never rely on blocking.
- **Interrupted states are first-class.** `INPUT_REQUIRED` and `AUTH_REQUIRED` are how an agent
  asks for human input or out-of-band authorization; the client continues by sending a `Message`
  with the same `taskId`. Section 7.6 explicitly describes the pattern eve already implements for
  connection OAuth: the agent parks in `AUTH_REQUIRED`, receives the credential out of band, and
  resumes without a client message.
- **Server generates ids.** `taskId` is always server-generated; clients cannot create tasks with
  their own ids. `contextId` may be server-generated and clients treat it as opaque.
- **Ownership is scoped to the caller.** `GetTask` / `ListTasks` MUST only return tasks visible to
  the authenticated caller.
- **Messages are not results.** Outputs go in `artifacts`; `status.message` carries
  clarifications and progress. History is best-effort.
- **`A2A-Version` header is required** and an empty value means 0.3. Unsupported versions get
  `VersionNotSupportedError` (`-32009`).
- **Errors are JSON-RPC codes `-32001..-32009`** with a `google.rpc.ErrorInfo` object in `data`
  (`reason`, `domain: "a2a-protocol.org"`).
- **The reference JS SDK (`@a2a-js/sdk`) is not a fit as a runtime dependency**: it depends on
  `jose`, peer-depends on Express and gRPC, and its server is Express-shaped. The subset eve needs
  (one JSON-RPC method set, SSE framing, the data model) is small enough to own. The SDK is the
  right `devDependency` for interop tests.

## Authoring API

### Consume an A2A agent: `defineA2AAgent`

```ts
// agent/subagents/travel-planner.ts
import { defineA2AAgent } from "eve";
import { bearer } from "eve/agents/auth";

export default defineA2AAgent({
  url: "https://travel.example.com", // origin; eve fetches /.well-known/agent-card.json
  description: "Plans multi-city itineraries and returns a day-by-day schedule.",
  auth: bearer(() => process.env.TRAVEL_AGENT_TOKEN!),
});
```

- Identity derives from the file path (`travel-planner`), as with every subagent. No `name`.
- `url: string | () => string` — the agent origin or a direct Agent Card URL. eve resolves the
  card at first dispatch per process, validates `supportedInterfaces` for a `JSONRPC` entry at
  `protocolVersion: "1.0"`, and caches it. Compile stays offline; `description` is authored so the
  parent's tool description does not depend on a network call at build.
- `auth?: OutboundAuthFn` and `headers?: HeadersValue` — identical to `defineRemoteAgent`. Card
  `securitySchemes` are informational in v1; eve does not negotiate OAuth from the card.
- `outputSchema?` — forwarded as a `data` part request via `acceptedOutputModes:
["application/json"]` and validated on the returned artifact, mirroring remote agents.
- `defineDynamic` works unchanged: return `defineA2AAgent(...)` or `null` from `session.started`.

The parent model sees the standard subagent tool (`{ message, outputSchema? }` → task receipt).
Semantics match a persistent remote child:

| Parent action                       | A2A operation                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| First call                          | `SendMessage` with `returnImmediately: true`; store `{ contextId, taskId }` on the child handle |
| Follow-up while task is interrupted | `SendMessage` with the stored `taskId` (continues that task)                                    |
| Follow-up after task is terminal    | `SendMessage` with the stored `contextId` only (new task in the same context)                   |
| Parent cancelled                    | `CancelTask` on the active task; failures logged, never block parent settlement                 |
| Waiting                             | Durable poll loop: `GetTask` after `sleep(min(backoff, 30s))`; no held HTTP connection          |

- **Waking the parent.** v1 polls with a durable sleep inside a workflow step rather than holding
  the blocking `SendMessage` or an SSE connection open. Polling is universal (every server MUST
  implement `GetTask`), it survives function timeouts, and it needs no inbound webhook. Push
  notifications are the obvious v2 optimization once a real caller needs lower latency.
- **Result projection.** Terminal `COMPLETED`: artifacts are flattened — `text` parts joined,
  a single `data` part returned as structured output when `outputSchema` was requested. `FAILED`
  and `REJECTED`: errored tool result carrying `status.message` text (`A2A_TASK_FAILED` /
  `A2A_TASK_REJECTED` when absent). `CANCELED`: cancelled result.
- **Interrupted states.** `INPUT_REQUIRED` and `AUTH_REQUIRED` surface to the parent as a task
  update with the remote `status.message` text, the same way a remote eve child reports a HITL
  request. The parent model answers by calling the subagent tool again; eve routes that message to
  the interrupted `taskId`. eve does not translate remote input requests into eve's structured
  `InputRequest` kinds in v1 — A2A carries free-form messages there, so the model does.

### Serve A2A: `a2aChannel`

```ts
// agent/channels/a2a.ts
import { a2aChannel } from "eve/channels/a2a";
import { oauthResource, oidc } from "eve/channels/auth";

export default a2aChannel({
  auth: oauthResource(oidc({ issuer: "https://auth.example.com", audience: "agent" }), {
    issuer: "https://auth.example.com",
  }),
  card: {
    version: "2.4.0",
    provider: { organization: "Acme", url: "https://acme.example.com" },
    documentationUrl: "https://acme.example.com/docs/agent",
  },
});
```

- `auth` is required, exactly as on `mcpChannel`; `none()` is the explicit public opt-in. Every
  operation reruns the policy. With authenticated policies a task belongs to the principal that
  created it (same owner key as MCP invocations); on a public channel the task id is a bearer
  capability until workflow retention expires.
- `route?` overrides the JSON-RPC path (default `/eve/v1/a2a`). The card is always served at
  `GET /.well-known/agent-card.json` on the deployment origin; the channel owns that route only
  when this file exists, so nothing is ambiently exposed.
- `card?` overrides fields eve cannot derive. Defaults:
  - `name`, `description` — from compiled agent metadata via the same agent-info responder the
    MCP channel uses.
  - `version` — the application's `package.json` version, falling back to the build id.
  - `skills` — one `AgentSkill` per static eve skill (`id`, `name`, `description`, `tags: []`),
    or a single skill for the agent when it has none. eve skills are descriptive instruction
    bundles, which is what A2A skills are.
  - `supportedInterfaces` — `[{ url: "<origin>/eve/v1/a2a", protocolBinding: "JSONRPC",
protocolVersion: "1.0" }]`.
  - `capabilities` — `{ streaming: true, pushNotifications: false, extendedAgentCard: false }`.
  - `defaultInputModes: ["text/plain", "application/json"]`,
    `defaultOutputModes: ["text/plain", "application/json"]`.
  - `securitySchemes` — `{ bearer: { httpAuthSecurityScheme: { scheme: "bearer" } } }` with a
    matching requirement, or an `openIdConnect` scheme when `oauthResource(...)` metadata is
    present. Authors override when their policy differs.
- The card is served with `cache-control: public, max-age=300` and no signature.

## Semantics of the served binding

### Operations

| JSON-RPC method                       | v1 behavior                                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SendMessage` (new task)              | Creates a task-mode session through the invocation kernel. Returns a `Task`. With `returnImmediately: false` (default) waits for terminal/interrupted state up to `blockingTimeoutMs` (default 60s, capped by host), then returns the current snapshot. |
| `SendMessage` (with `taskId`)         | Task must be `INPUT_REQUIRED`; the message answers the pending batch (see below). Terminal tasks → `UnsupportedOperationError`. Unknown → `TaskNotFoundError`.                                                                                          |
| `SendMessage` (with `contextId` only) | v1 rejects with `UnsupportedOperationError` and reason `CONTEXT_CONTINUATION_UNSUPPORTED` (spec §3.4.1 requires rejection rather than a new id).                                                                                                        |
| `SendStreamingMessage`                | Same as above but responds with SSE: initial `Task`, then `statusUpdate` / `artifactUpdate` events derived from the session stream; closes at terminal state. Interrupted states keep the stream open until the deadline.                               |
| `GetTask`                             | Projects the invocation; honors `historyLength`.                                                                                                                                                                                                        |
| `SubscribeToTask`                     | SSE from the current snapshot; terminal → `UnsupportedOperationError`.                                                                                                                                                                                  |
| `CancelTask`                          | `getRun(id).cancel()`; returns the snapshot. Cancellation is cooperative; the snapshot may still read `WORKING` until `turn.cancelled` lands. Terminal → `TaskNotCancelableError`.                                                                      |
| `ListTasks`                           | `UnsupportedOperationError`. The workflow world cannot filter runs by attribute today, so an owner-scoped list would be unbounded work (see open questions).                                                                                            |
| Push notification methods             | `PushNotificationNotSupportedError`.                                                                                                                                                                                                                    |
| `GetExtendedAgentCard`                | `ExtendedAgentCardNotConfiguredError`.                                                                                                                                                                                                                  |

`A2A-Version` must be `1.0`; anything else, including empty, returns `VersionNotSupportedError`.
Requests exceeding a body cap (1 MiB) or containing `raw` parts above a size cap are rejected
with a JSON-RPC invalid-params error.

### Task projection

| eve invocation status      | A2A `status.state`          | Notes                                                                                                                                                                             |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| created, no `turn.started` | `TASK_STATE_SUBMITTED`      | Only visible on the immediate `returnImmediately` response.                                                                                                                       |
| `working`                  | `TASK_STATE_WORKING`        | `status.message` carries the latest `task_update` text when present.                                                                                                              |
| `input_required`           | `TASK_STATE_INPUT_REQUIRED` | `status.message` has a `text` part rendering each request and one `data` part with the raw `InputRequest[]`.                                                                      |
| `authorization_required`   | `TASK_STATE_AUTH_REQUIRED`  | `status.message` has the challenge (`url`, `userCode`, `instructions`) as text and a `data` part. The connection callback resumes the task; no client message is needed (§7.6.1). |
| `completed`                | `TASK_STATE_COMPLETED`      | One artifact: `text` part for a text result, `data` part for structured output.                                                                                                   |
| `failed`                   | `TASK_STATE_FAILED`         | `status.message` carries the sanitized error message; internals stay in server logs.                                                                                              |
| `cancelled`                | `TASK_STATE_CANCELED`       |                                                                                                                                                                                   |

- `id` and `contextId` are both the eve session id in v1. `history` is the initiating user
  message plus the final agent message; eve does not persist per-step assistant messages into
  task history.
- `status.timestamp` is the `meta.at` of the event that produced the state, ISO 8601 with
  millisecond precision.
- Answering `INPUT_REQUIRED`: the client message must contain a `data` part
  `{ responses: InputResponse[] }` answering the complete pending batch exactly once (same rule
  as MCP `agent_update`). When the batch is a single free-form question, a lone `text` part is
  accepted as its answer. Anything else → invalid params with a message naming the pending request
  ids.
- Inbound message parts: `text` parts concatenate into the user message; `data` parts are
  serialized as fenced JSON; `url` parts are passed through as text for the model; `raw` parts are
  rejected in v1 (`ContentTypeNotSupportedError`) until eve's file-part story is settled.

### Streaming

SSE events map from eve's durable stream with no new persistence:

- `turn.started`, `input.requested`, `authorization.required`, `authorization.completed`,
  `turn.completed`, `turn.failed`, `turn.cancelled` → `statusUpdate`.
- `message.appended` (final assistant message deltas) → `artifactUpdate` with `append: true`;
  `message.completed` → final `artifactUpdate` with `lastChunk: true`.
- Reasoning, tool calls, and subagent events are not forwarded; A2A is opaque by design.

Reconnection is `SubscribeToTask`, which replays the snapshot first, then tails from the current
stream index — the same tail-relative read the eve channel already supports.

## Boundaries and surfaces

| Surface                                                                      | Change                                                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `internal/a2a/types.ts`, `internal/a2a/jsonrpc.ts` (new)                     | eve-owned v1.0 data model (camelCase, SCREAMING_SNAKE enums), error table, SSE framing. No runtime dependency.                |
| `internal/invocation/agent-invocation.ts`, `workflow-execution.ts`           | Unchanged kernel; add `subscribe(invocationId, startIndex)` returning the session event stream for SSE.                       |
| `public/channels/a2a.ts` (new), export `eve/channels/a2a`                    | `a2aChannel`: card route, JSON-RPC route, auth via `routeAuth` + `oauthResource` (same as `mcpChannel`).                      |
| `public/definitions/a2a-agent.ts` (new), export from `eve`                   | `defineA2AAgent` stamping `kind: "a2a"`; `compiler/normalize-subagent.ts` accepts the new kind.                               |
| `runtime/a2a/client.ts`, `execution/a2a-agent-dispatch.ts` (new)             | Card resolution, `SendMessage` / `GetTask` / `CancelTask`, durable poll loop, handle bookkeeping (`contextId`, `taskId`).     |
| `execution/subagent-tool.ts`, `runtime/subagents/registry.ts`                | Route `kind: "a2a"` nodes to the A2A dispatcher beside `remote`.                                                              |
| `docs/protocols/a2a.md`, `docs/channels/a2a.mdx`, `docs/subagents/index.mdx` | Serving and consuming guides; remove the "not an A2A server" caveat from `docs/channels/eve.mdx` for deployments that opt in. |
| `e2e/fixtures/agent-a2a/` (new)                                              | Loopback: the fixture serves `a2aChannel` and consumes itself through `defineA2AAgent`.                                       |

Invariants:

- Everything A2A-specific lives in `public/channels/a2a.ts`, `runtime/a2a/`, and
  `execution/a2a-agent-dispatch.ts`. `execution/` and `harness/` core paths do not learn about
  A2A beyond the `kind` dispatch already present for `remote`.
- Client-facing errors carry the A2A reason and a generic message; stack traces and workflow
  internals stay in logs.
- Outbound requests go only to the card's declared interface URL, which must be HTTPS in
  production and must not resolve to a reserved address (reuse `isReservedIpAddress`).

## Out of scope for v1

- HTTP+JSON and gRPC bindings; A2A 0.3 compatibility.
- Push notifications (both directions), `ListTasks`, extended agent card, card signatures
  (JWS + RFC 8785 canonicalization).
- `contextId` continuity on the served side. Planned mapping once immutable tasks exist:
  `contextId` = conversation-mode session, `taskId` = turn.
- Translating remote `INPUT_REQUIRED` payloads into eve structured `InputRequest` kinds.
- Replacing eve-to-eve `defineRemoteAgent` with A2A. eve's native hop carries forwarded
  principals, structured HITL, activity observers, and trace policy that A2A lacks; A2A is for
  crossing framework boundaries, not for eve talking to eve.
- Advertising eve tools or connections as A2A skills beyond the descriptive skill list.

## Open questions

- **`ListTasks` needs an attribute-filtered run query.** The kernel keys ownership on run
  attributes but `world.runs.list` filters only by workflow name and status. Either the workflow
  world grows an attribute filter or eve maintains a per-owner index; until then the operation is
  unsupported.
- **Blocking deadline.** Spec says `SendMessage` MUST wait; hosts cap request duration. Is a
  documented `blockingTimeoutMs` deviation acceptable, or should the default flip to
  `returnImmediately`-like behavior with `capabilities` metadata explaining it?
- **Card `version` source.** Application `package.json` version is the least surprising default
  but many eve apps never bump it. Build id fallback keeps the field populated but not meaningful.
- **Skill mapping.** Confirm that surfacing eve skill names and descriptions publicly on the card
  is acceptable; skills may contain internal wording. An allowlist on `card.skills` may be needed.

## Delivery and verification

Two PRs, each with a **patch** changeset (additive public API):

1. **Serve.** `a2aChannel`, card, JSON-RPC route, SSE. Unit: projection table, error mapping,
   version negotiation, input-answer validation, card defaults and overrides. Integration: route
   auth + ownership (other principal → `TaskNotFoundError`), blocking vs `returnImmediately`.
   Scenario: `@a2a-js/sdk` client (devDependency) against a real `eve dev` server runs
   `SendMessage`, `GetTask`, `SendStreamingMessage`, `CancelTask`, and `INPUT_REQUIRED` round
   trip. E2E: `agent-a2a` fixture eval with the mock model.
2. **Consume.** `defineA2AAgent`, client, dispatcher. Unit: card resolution and interface
   selection, handle bookkeeping across interrupted/terminal tasks, artifact flattening, error
   projection. Integration: dispatch → poll → result in memory with a stubbed A2A server. E2E:
   the `agent-a2a` fixture delegates to itself over the loopback route and cancels mid-task.
