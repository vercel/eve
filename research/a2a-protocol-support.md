---
issue: TBD
status: proposed
last_updated: "2026-09-05"
---

# A2A protocol support

## Decision

eve should support A2A 1.0 in both directions:

- `defineA2AAgent` consumes a remote A2A agent as an eve subagent.
- `a2aChannel` exposes an eve agent as an A2A server.
- The first release supports the JSON-RPC binding, SSE streaming, polling, cancellation, and
  `ListTasks`. It does not support A2A 0.3, HTTP+JSON, gRPC, push notifications, signed cards, or
  authenticated extended cards.
- Vercel Connect is the recommended OAuth provider for outbound A2A calls. A2A remains a subagent
  abstraction, but it reuses the protocol-neutral authorization runtime already used by MCP and
  OpenAPI connections.

This design targets the official `a2aproject/A2A` `v1.0.1` tag (`3303592`). A2A negotiates only
`Major.Minor`, so cards and requests use `1.0`, not `1.0.1`.

```text
 eve as A2A client                              eve as A2A server

 agent/subagents/planner.ts                     agent/channels/a2a.ts
 defineA2AAgent(...)                            a2aChannel(...)
          │                                              │
          │ GET /.well-known/agent-card.json             │
          ├─────────────────────────────────────────────▶│ Agent Card
          │                                              │
          │ POST /eve/v1/a2a                             │
          │ Authorization + SendMessage                  │
          ├─────────────────────────────────────────────▶│ task-mode session
          │                                              │
          │ GetTask / CancelTask / SendMessage           │
          ◀─────────────────────────────────────────────▶│ durable invocation
```

## Why A2A maps to these eve concepts

A2A delegates work to an opaque agent. It does not expose a tool list, so an A2A client belongs
under `agent/subagents/`, not `agent/connections/`.

An A2A server accepts messages and manages durable tasks. That is a channel over eve's existing
`WorkflowAgentInvocationExecution`: task-mode sessions already expose working, input-required,
authorization-required, completed, failed, and canceled states with ownership and durable events.
The A2A channel translates that invocation model without adding A2A concepts to the execution
kernel.

## Consume an A2A agent

### Recommended: OAuth through Vercel Connect

```ts
// agent/subagents/travel-planner.ts
import { connect } from "@vercel/connect/eve";
import { defineA2AAgent } from "eve";

export default defineA2AAgent({
  url: "https://travel.example.com",
  description: "Plans multi-city itineraries and returns a day-by-day schedule.",
  auth: connect("travel.example.com/travel-planner"),
});
```

`connect(...)` is user-scoped by default. The active eve session must contain an authenticated user
principal, and each user authorizes their own account. Use an app-scoped connector for a shared
machine identity:

```ts
auth: connect({
  connector: "travel.example.com/travel-planner",
  principalType: "app",
});
```

App-scoped auth must resolve without eve's interactive browser flow. Interactive OAuth remains
user-scoped.

### Static or custom credentials

`auth` accepts the same `ConnectionAuthDefinition` as MCP and OpenAPI connections. `headers`
accepts their shared `HeadersDefinition` for API keys and other non-Bearer schemes.

```ts
import { defineA2AAgent } from "eve";

export default defineA2AAgent({
  url: "https://research.example.com/agent-card.json",
  description: "Researches a supplied topic.",
  auth: {
    getToken: async () => ({ token: process.env.RESEARCH_AGENT_TOKEN! }),
  },
});
```

### Definition shape

```ts
interface A2AAgentDefinitionInput {
  readonly url: string | (() => string | Promise<string>);
  readonly description: string;
  readonly auth?: ConnectionAuthDefinition;
  readonly headers?: HeadersDefinition;
  readonly allowedInterfaceOrigins?: readonly string[];
  readonly outputSchema?: StandardJSONSchemaV1<unknown, unknown> | JsonObject;
}
```

- Identity derives from the file path. `agent/subagents/travel-planner.ts` becomes
  `travel-planner`; there is no `name` field.
- `url` may be an origin or a direct Agent Card URL. An origin resolves to
  `/.well-known/agent-card.json`.
- `allowedInterfaceOrigins` contains exact origins for registry-hosted cards that intentionally
  point somewhere other than the card origin. Wildcards are not accepted.
- `description` is authored because compile remains offline. Card discovery happens at runtime.
- `defineDynamic` may return `defineA2AAgent(...)` or `null` from `session.started`.

### Discovery and authentication flow

```text
1. Resolve the authored card URL.
2. Fetch the public card without auth or authored headers.
3. Validate the complete A2A 1.0 Agent Card.
4. Select the first JSONRPC/1.0 interface in card preference order.
5. Reject an unknown required extension or an unapproved interface origin.
6. Resolve auth for the active app or user principal.
7. Send the A2A request with A2A-Version: 1.0 and the selected interface's tenant.
8. On HTTP 401, evict the rejected token and attempt authorization once before surfacing the error.
```

The Agent Card describes acceptable security schemes and OAuth scopes. It does not choose or
provision eve's credential. The authored Vercel Connect connector is the trust boundary: it owns
the registered OAuth client, provider configuration, token storage, and refresh. eve does not start
OAuth against an issuer named only by an untrusted card.

If a user-scoped Connect credential is missing, eve emits `authorization.required`, parks the parent
turn on its existing durable callback, and resumes the original subagent call after Connect
completes OAuth. Tokens are resolved per execution step and are never serialized into workflow
state.

This requires generalizing the shared authorization runtime's current connection-oriented names:

```ts
interface OutboundAuthorizationContext {
  readonly scope: string; // path-derived connection or subagent identity
  readonly protocol: "mcp" | "openapi" | "a2a";
  readonly url: string; // selected remote service URL
}
```

The token cache, principal resolution, challenge, callback, completion, and eviction logic remain
unchanged. The A2A compiler path also preserves Vercel Connect's serializable connector marker on
the subagent node for setup and deployment tooling. A2A does not become a connection and does not
appear in `connection_search`.

### Task flow

The parent model sees the standard background subagent tool.

| Parent action              | A2A operation                                 |
| -------------------------- | --------------------------------------------- |
| First call                 | `SendMessage` with `returnImmediately: true`  |
| Wait for a task            | Durable `GetTask` polling with capped backoff |
| Answer `INPUT_REQUIRED`    | `SendMessage` with the active `taskId`        |
| Follow up after completion | `SendMessage` with the stored `contextId`     |
| Cancel the parent          | Best-effort `CancelTask` for the active task  |

`SendMessage` may return either:

- A direct `Message`: complete the subagent call immediately and retain its `contextId`, if present.
- A `Task`: store `{ contextId, taskId }`, then poll. Polling avoids holding an HTTP connection and
  works with every conforming server.

For a completed task, eve joins text artifact parts. When `outputSchema` is present, eve requests
`application/json` and validates a single data part. Failed and rejected tasks return typed tool
errors; canceled tasks return a canceled result.

`INPUT_REQUIRED` and `AUTH_REQUIRED` surface as child task updates. The parent can answer an input
request by calling the subagent again. `AUTH_REQUIRED` means the remote task needs secondary
authorization; it is not the OAuth used to call the A2A endpoint. The remote agent receives that
credential out of band while eve continues polling the same task.

## Serve an eve agent over A2A

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
    skills: [
      {
        id: "travel-planning",
        name: "Travel planning",
        description: "Plans multi-city itineraries.",
        tags: ["travel", "itinerary"],
      },
    ],
    securitySchemes: {
      oidc: {
        openIdConnectSecurityScheme: {
          openIdConnectUrl: "https://auth.example.com/.well-known/openid-configuration",
        },
      },
    },
    securityRequirements: [{ schemes: { oidc: { list: ["a2a.invoke"] } } }],
  },
});
```

`auth` is required. Use `none()` for an intentionally public agent. `routeAuth` authenticates every
request; `oauthResource(...)` also supplies challenge metadata. When eve cannot derive an exact
Agent Card declaration from the auth policy, the author must provide matching `securitySchemes`
and `securityRequirements`. Channel construction fails rather than advertising a generic Bearer
scheme that may not match the route.

The channel exposes:

```text
GET  /.well-known/agent-card.json
POST /eve/v1/a2a
```

`route` may override the JSON-RPC path. The well-known path is deployment-global, so v1 permits one
A2A channel per deployment.

### Agent Card defaults

The public Agent Card contains only metadata safe for anonymous callers:

- `name` and `description` from compiled agent metadata.
- `version` from the application package version, with the build id as a fallback.
- One agent-level skill by default. Individual eve skills are included only through explicit
  `card.skills`; internal skill instructions are never published automatically.
- One `JSONRPC` interface at the channel route with protocol version `1.0`.
- `streaming: true`, `pushNotifications: false`, and `extendedAgentCard: false`.
- `text/plain` and `application/json` input and output modes.
- Empty security requirements for `none()`, or the exact declaration configured for authenticated
  routes.

The response includes `Cache-Control: public, max-age=300` and a content-hash `ETag`. The first
release does not sign cards.

### Request and ownership flow

```text
A2A request
  │
  ├─ validate A2A-Version, tenant, JSON-RPC envelope, and body limits
  ├─ authenticate with routeAuth
  ├─ derive the invocation owner from the authenticated principal
  ├─ authorize the operation before reading or writing a task
  ├─ project A2A input onto WorkflowAgentInvocationExecution
  └─ return a Task snapshot or SSE event stream
```

Primary auth failures remain HTTP-level responses:

- `401` plus `WWW-Authenticate` for missing or invalid credentials.
- `403` for an authenticated caller without permission.

Neither response creates a task or uses `TASK_STATE_AUTH_REQUIRED`. Every continuation, poll,
cancel, list, and stream subscription reruns auth. Unknown and inaccessible task ids both return
`TaskNotFoundError` so task existence does not leak.

With `none()`, a cryptographically unguessable task id acts as a bearer capability until workflow
retention expires. This is weaker than principal-bound ownership and must remain an explicit opt-in.

### Operation mapping

| A2A operation             | eve behavior                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `SendMessage`             | Create a task-mode session, or answer its pending input request.                              |
| `SendStreamingMessage`    | Return the initial task, then ordered `taskStatusUpdate` and `taskArtifactUpdate` SSE events. |
| `GetTask`                 | Return the current invocation projection and requested history.                               |
| `ListTasks`               | Query owner-scoped invocations with filters and opaque cursor pagination.                     |
| `SubscribeToTask`         | Return the current snapshot first, then tail durable events until terminal state.             |
| `CancelTask`              | Request cooperative workflow cancellation and return the current snapshot.                    |
| Push notification methods | Return `PushNotificationNotSupportedError`.                                                   |
| `GetExtendedAgentCard`    | Return `UnsupportedOperationError` because the card advertises no support.                    |

`ListTasks` is a core A2A 1.0 operation. Serving A2A therefore requires an owner-scoped invocation
query that supports context, state, timestamp, descending update order, cursor pagination, history
length, and artifact inclusion. Authorization must be part of the query so counts and timing do not
leak inaccessible runs.

`SendMessage` defaults to blocking until a terminal or interrupted state, as required by the
normative proto. `returnImmediately: true` returns the submitted task. If the hosting platform ends
a blocking request first, the caller receives a transport failure and can retry with
`returnImmediately: true`; eve must not return a nonstandard working snapshot at an arbitrary
framework timeout.

### Task projection

| eve invocation         | A2A state                   | Payload                                               |
| ---------------------- | --------------------------- | ----------------------------------------------------- |
| Created                | `TASK_STATE_SUBMITTED`      | Initial task snapshot.                                |
| Working                | `TASK_STATE_WORKING`        | Latest public task update in `status.message`.        |
| Input required         | `TASK_STATE_INPUT_REQUIRED` | Human-readable text plus structured `InputRequest[]`. |
| Authorization required | `TASK_STATE_AUTH_REQUIRED`  | Safe challenge instructions; never credentials.       |
| Completed              | `TASK_STATE_COMPLETED`      | Text or structured result as an artifact.             |
| Failed                 | `TASK_STATE_FAILED`         | Sanitized message; details remain in server logs.     |
| Canceled               | `TASK_STATE_CANCELED`       | No result artifact.                                   |

In v1, `taskId` and `contextId` both map to the task-mode eve session id. A client may continue an
interrupted task by `taskId`. A client-supplied `contextId` that does not identify that task is
rejected. Mapping one conversation to multiple immutable tasks waits for the tools-as-tasks work:
`contextId` will then map to the conversation and `taskId` to one turn.

Inbound text parts concatenate into the user message. Data parts become fenced JSON. URL parts are
shown to the model as text and are not fetched by the protocol layer. Raw parts are rejected until
eve has a file-part contract. Request bodies are capped at 1 MiB.

## Security boundaries

- Production card and interface URLs require HTTPS; loopback HTTP is development-only.
- Card discovery sends no invocation credentials or authored headers.
- Card and interface requests do not follow redirects.
- The selected interface must share the card origin unless its exact origin is authored in
  `allowedInterfaceOrigins`.
- Credentials are sent only to the selected, approved interface origin.
- Network validation covers literal and resolved loopback, private, link-local, multicast, and
  cloud metadata addresses. The connection must stay bound to a validated address to prevent DNS
  rebinding.
- Unknown required extensions fail before auth or dispatch. v1 activates no extensions.
- Cards follow HTTP caching rules and revalidate with `ETag` or `Last-Modified`. A refresh that
  changes the approved origin or required auth/extension contract fails closed for existing task
  handles.
- Tokens, authorization codes, API keys, and callback secrets never enter A2A messages, artifacts,
  metadata, URLs, model context, durable workflow state, or logs.
- In-task authorization remains bound to the principal, task, tenant, downstream audience, and
  scopes to prevent confused-deputy and cross-task replay attacks.

## Implementation boundaries

| Surface                               | Change                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `public/definitions/a2a-agent.ts`     | Add `defineA2AAgent` with shared outbound auth and headers.                                                   |
| A2A compiler and runtime graph paths  | Preserve live auth resolvers and Vercel Connect's serializable connector marker on A2A nodes.                 |
| `runtime/a2a/client.ts`               | Resolve cards, authorize requests, and implement JSON-RPC operations.                                         |
| `execution/a2a-agent-dispatch.ts`     | Lower A2A agents to background subagent execution.                                                            |
| Shared outbound authorization runtime | Generalize connection-specific context and cache keys for A2A subagents without exposing them as connections. |
| `public/channels/a2a.ts`              | Add the card and authenticated JSON-RPC routes.                                                               |
| `internal/a2a/*`                      | Own the A2A 1.0 data model, validation, errors, and SSE framing without a runtime dependency.                 |
| Invocation kernel                     | Add SSE subscription and owner-scoped filtered listing; keep A2A types out of the kernel.                     |

The official `@a2a-js/sdk` remains a development dependency for interoperability tests. Its Express,
gRPC, and `jose` dependency surface is not suitable for eve's runtime package.

## Out of scope for the first release

- A2A 0.3, HTTP+JSON, and gRPC bindings.
- Push notifications and their webhook auth, SSRF, retry, and replay surface.
- Authenticated private cards, extended cards, and caller-specific capability disclosure.
- Agent Card JWS signing and RFC 8785 canonicalization.
- Automatic OAuth/OIDC/device-flow negotiation from card metadata.
- mTLS client identity.
- General registry search or model-selected remote agents.
- Translating arbitrary remote input payloads into every eve `InputRequest` kind.
- Replacing eve-to-eve `defineRemoteAgent`, which carries eve-specific principal and trace policy.

## Open questions

- **Owner-scoped listing:** Should the workflow world add a general attribute-filtered run query, or
  should the invocation layer maintain its own owner index?
- **Agent version:** Is the application package version meaningful enough for the card, or should
  `card.version` be required?
- **Multiple agents per deployment:** A future card-routing surface is required before multiple A2A
  channels can share one deployment origin.

## Verification

Deliver serving and consuming support separately, each with a patch changeset.

1. **Serve:** test card defaults and security declarations, ETags, version and tenant validation,
   HTTP `401`/`403`, owner isolation, input continuation, task projection, list filtering and
   pagination, SSE ordering, cancellation, body limits, and unsupported capabilities. Run the
   official JS client against `eve dev` in a scenario test.
2. **Consume:** test card schema and cache revalidation, interface preference and tenant echo,
   required extensions, direct Message and Task responses, Vercel Connect authorization and resume,
   user isolation, rejected-token eviction, cross-origin credential prevention, redirect handling,
   DNS and literal-address SSRF, polling, continuation, result projection, and cancellation.
3. **E2E:** add a loopback fixture that serves `a2aChannel`, consumes itself through
   `defineA2AAgent`, completes a task, handles input, and cancels active work.
