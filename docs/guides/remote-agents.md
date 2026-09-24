---
title: "Remote Agents"
description: "Call another eve deployment as a subagent with defineRemoteAgent: the same tool call as a local subagent, with outbound auth and durable callbacks."
---

`defineRemoteAgent` calls a separately deployed eve agent as if it were a local subagent. Reach for it when the specialist you delegate to is a separately owned agent behind its own URL rather than a directory in your repo.

The file lives under `agent/subagents/`, so its tool name is derived from the path. There's no `name` field.

```ts title="agent/subagents/weather.ts"
import { defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

export default defineRemoteAgent({
  url: "https://weather-agent.example.com",
  description: "Answers weather, temperature, forecast, wind, rain, and snow questions.",
  auth: vercelOidc(),
});
```

`defineRemoteAgent` accepts:

| Parameter          | Type                                          | Required | Default           | Description                                                                                                                                              |
| ------------------ | --------------------------------------------- | -------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`              | `string \| (() => string \| Promise<string>)` | Yes      | n/a               | Base URL of the remote eve deployment to call. A string is baked at compile time; a function is resolved at runtime (see [Runtime URLs](#runtime-urls)). |
| `description`      | `string`                                      | Yes      | n/a               | Model-visible delegation description.                                                                                                                    |
| `auth`             | `OutboundAuthFn`                              | No       | none              | Outbound auth hook from `eve/agents/auth`.                                                                                                               |
| `forwardPrincipal` | `boolean`                                     | No       | `false`           | Forward the dispatching turn's session principal to the remote deployment (see [Forwarding the caller identity](#forwarding-the-caller-identity)).       |
| `headers`          | `HeadersValue`                                | No       | none              | Static or lazily resolved request headers.                                                                                                               |
| `path`             | `string`                                      | No       | `/eve/v1/session` | Route appended to `url` for the create-session request.                                                                                                  |
| `outputSchema`     | `StandardSchema \| JSON Schema`               | No       | none              | Structured return type for the first turn of each fresh remote session. A continuation may provide its own per-call schema.                              |
| `timeout`          | `number \| false`                             | No       | `7_200_000`       | Time limit for each call, in milliseconds of active time. A call still working at the limit fails with `TIMED_OUT`. `false` removes the limit.           |
| `tool`             | `boolean`                                     | No       | `true`            | Expose the remote agent as a tool to the parent model. Set `false` to allow only `ctx.agent()` calls from authored workflow tools.                       |

## Dynamic remote agents

Wrap the file in `defineDynamic` when the target or its availability depends on
the current session. Return `defineRemoteAgent(...)` to expose it and `null` to
omit it:

```ts title="agent/subagents/weather.ts"
import { defineDynamic, defineRemoteAgent } from "eve";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      ctx.session.auth.current?.attributes.region === "us"
        ? defineRemoteAgent({
            description: "Answers weather questions for US customers.",
            url: "https://us-weather-agent.example.com",
          })
        : null,
  },
});
```

Dynamic remote subagents support `session.started` and `turn.started`. The
returned definition may select different remote settings at either scope. eve
resolves function-valued URLs when the event handler runs. Auth and headers
remain lazy and resolve before each outbound request without entering durable
workflow state.

Author `auth` and `headers` directly in the `defineRemoteAgent({ ... })` object
and keep their functions self-contained with module imports or environment
variables. They are rehydrated outside the event handler, so they cannot close
over `_event`, `ctx`, or handler-local values.

## Runtime URLs

A string `url` is read at compile time and frozen into the build. When the target comes from a runtime env var — known only once the deployment runs — pass a function instead. eve calls it when it resolves the agent graph at runtime, so it can read `process.env`:

```ts title="agent/subagents/weather.ts"
import { defineRemoteAgent } from "eve";

export default defineRemoteAgent({
  url: () => process.env.WEATHER_AGENT_URL ?? "https://weather-agent.example.com",
  description: "Answers weather, temperature, forecast, wind, rain, and snow questions.",
});
```

The function may be async and must return a non-empty string. `auth` and `headers` are resolved at runtime the same way.

## Calling a remote agent

By default, a remote agent is another subagent tool to the model. The model calls it the same way it calls a local subagent, with a `message` and an optional `outputSchema`. Set `tool: false` when an authored workflow tool should be the only model-facing routing surface; the workflow can still call the remote agent by its path-derived name through `ctx.agent()`. The message must carry the full task, including any context the remote agent needs, because it never receives the parent's conversation history.

To require structured output, set an `outputSchema` on the agent definition for fresh delegations or on an individual call for that turn. The structured value becomes the tool result, and the remote child remains available for follow-up messages. See [Subagents](../subagents) for continuation behavior.

## Outbound auth

Use `vercelOidc()` from `eve/agents/auth` when one Vercel-deployed eve agent calls another, as shown in the first example on this page.

For calls between different Vercel projects, allow the calling project on the receiving agent's eve channel:

```ts title="agent/channels/eve.ts"
import { vercelOidc, vercelSubject } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [
    vercelOidc({
      subjects: [
        vercelSubject({
          teamSlug: "acme",
          projectName: "calling-agent",
          environment: "production",
        }),
      ],
    }),
  ],
});
```

Set `teamSlug`, `projectName`, and `environment` to the calling deployment's Vercel OIDC subject. See [subject patterns and `vercelSubject(...)`](./auth-and-route-protection#subjects-patterns-and-vercelsubject) for other environments and wildcard matching.

If [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection) is active on the receiving project, also configure [Trusted Sources](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources) to allow the calling project and environment. The eve subject allowlist and Trusted Sources are separate checks; cross-project calls need both.

## Forwarding the caller identity

Outbound auth authenticates your _deployment_ to the remote, so by default the remote session runs as your calling app — not as the end user who is talking to your agent. That breaks per-user workloads on the remote deployment, most directly per-user [Vercel Connect](./auth-and-route-protection#tool-and-connection-auth), which requires an authenticated `user` principal on the session.

Set `forwardPrincipal: true` to forward the dispatching turn's session principal across the hop:

```ts title="agent/subagents/site-ops.ts"
import { defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

export default defineRemoteAgent({
  url: "https://site-ops.example.com",
  description: "Executes site operations as the requesting user.",
  auth: vercelOidc(), // transport trust: authenticates *this* deployment
  forwardPrincipal: true, // identity: asserts the current session principal
});
```

The create-session request carries the parent turn's `session.auth.current` and `session.auth.initiator` as a `forwardedPrincipal` body field (`initiator` is optional on the wire; when absent, the receiver seeds both from `current`). Every continuation carries only that turn's `session.auth.current`; the remote session keeps its original `auth.initiator`. Only principal metadata crosses the wire — never tokens or credentials. The receiving deployment resolves its own per-user credentials through its own connections.

This keeps caller authority with the principal that started the child, even when the remote child session is persistent. Only that principal can continue the child: if Alice starts it and Bob's turn later names its `agentId`, the call fails with `AGENT_OTHER_PRINCIPAL`, and Bob's request needs a new child, which acts as Bob. When the parent turn's auth is `null`, a new local child has no `auth.current`, while a new remote child uses the freshly verified transport principal. eve's in-step bearer cache is also keyed by the resolved principal and is not serialized across steps. The external authorization provider may preserve each user's server-side OAuth grant, but a turn can resolve only the grant belonging to its own `auth.current` principal.

The principal check covers calls made through the parent. The remote child is still an ordinary session on the remote deployment, and its conversation history, tool outputs, and other state persist there. If those values must not be visible across users, also enforce that ownership at the remote deployment's boundary.

Forwarding identity is explicit on both sides. The receiver names which deployments it trusts with `eveChannel({ trustedForwarders })` and can limit each one to the principals it may assert (see [Auth & route protection](./auth-and-route-protection#accepting-forwarded-identity-from-another-deployment)); refusing the forwarder or what it asserts rejects a forwarded principal with a 403. The same trust decision covers parent session lineage and, with principal forwarding, trace-content constraints.

## Trace propagation

Each remote turn starts a new trace. eve links the child trace to the
dispatching turn and carries `gen_ai.conversation.id` so you can find the
traces for one conversation. Trace context is observability metadata, not an
authorization grant. See [OpenTelemetry](../observability/otel#trace-topology)
for the trace topology.

eve carries parent session lineage separately. The receiver accepts it only
when `trustedForwarders` approves the authenticated caller; otherwise, trace
correlation continues without it.

## Preserving trace content

With `forwardPrincipal: true`, a sampled remote dispatch forwards its original
audience and the maximum input and output content the next hop may record. eve
sends this policy as [W3C Baggage](https://www.w3.org/TR/baggage/).

The receiving deployment uses the policy only after it trusts the calling
deployment:

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { vercelOidc, vercelSubject } from "eve/channels/auth";

export default eveChannel({
  auth: [vercelOidc()],
  trustedForwarders: (forwarder) =>
    forwarder.subject === vercelSubject({ teamSlug: "acme", projectName: "router" }),
});
```

The request must include a callback and a valid sampled `traceparent`.
`trustedForwarders` is the authorization boundary. When the assertion is
accepted, the receiver uses the forwarded audience instead of reclassifying
the child session with its local channel.

The receiver combines the forwarded ceiling with its own trace policy. Each
hop may narrow content capture, but cannot restore inputs or outputs removed by
an earlier hop. Missing, malformed, unsampled, or untrusted assertions do not
widen capture and use metadata-only tracing.

## How remote dispatch and callbacks work

A remote subagent runs in its own deployment, and the parent turn waits for its answer:

1. The parent reads the remote's task protocol version from `GET /eve/v1/health`, then starts a persistent conversation session on the remote's `POST /eve/v1/session`, passing a framework callback URL, the parent session's capabilities, and its task protocol version.
2. The remote child runs its turn. Questions, approvals, and sign-in prompts it raises travel back through the same callback URL.
3. The child posts its answer to the callback URL, and the answer becomes the tool result for the parent's call.

A remote call is a [task](../concepts/tasks) like a local one: the parent stream carries the same `task.started`, `action.result`, and `task.settled` events as local delegation, and the same receipts, detach, cancellation, and time limits apply. For a remote call, `task.started.data.child.remote.url` records the target.

In an interactive root session, the model can run a remote agent call in the background with `background: true`, exactly as with a local subagent: the call returns a receipt, and the remote child's answer arrives through the same callback and reaches the model later in a `task.result` message. See [Run a call in the background](../subagents#run-a-call-in-the-background).

Passing the `agentId` of a remote child that is still working sends its message as a steering message for the child's current call, as for a local child. The remote child applies the message to its current turn, or, when it already answered, runs the message as its next turn for the same call; the parent then tracks that turn as the child's next background work, and its answer arrives through the callback. Only the principal whose call started the child's current work can give it more work or send it a message; a call from another principal fails with `AGENT_OTHER_PRINCIPAL`. When the definition forwards the caller identity, the continue request forwards that same principal.

Clients follow a remote child through the parent. [`session.streamSubagent()`](./client/streaming#follow-a-subagent) reads `task.started.data.child.streamPath`, a route on the parent deployment. The parent verifies that the child belongs to that session, resolves the remote agent's `auth` and `headers`, and relays the child's stream. A browser never calls the remote deployment or holds its credentials; it only needs access to the parent session.

Each remote call has the same time limit as a local one: 2 hours of active time unless you set `timeout` on the definition, in milliseconds, or `false` to keep only the parent session's lifetime as the limit. Time the child spends waiting on a person does not count. A call still working at the limit fails with `TIMED_OUT`, and eve sends the remote child a cancellation. A remote agent that typically runs longer needs a larger `timeout`:

```ts title="agent/subagents/content.ts"
import { defineRemoteAgent } from "eve";

export default defineRemoteAgent({
  url: () => process.env.CONTENT_AGENT_URL ?? "https://content-agent.example.com",
  description: "Drafts long-form content. Typical runs take 5 to 15 minutes.",
  timeout: 3 * 60 * 60_000,
});
```

Cancelling the parent turn cancels the remote child's current turn. eve resolves the remote's `headers` and `auth` again for every cancellation attempt, so rotating credentials work the same way as they do for session creation. Cancellation always uses the standard eve cancel path on `url`, even when `path` customizes only the create-session endpoint. The remote child reports `turn.cancelled` → `session.waiting` on its own stream. eve sends a cancel that failed in a way that may clear, such as a timeout, once more; an unreachable remote is logged but cannot turn the parent's cancellation into a failure.

When the parent session ends, eve sends an authenticated `POST /eve/v1/session/:childSessionId/reset` for each remote child. Reset retires the parked remote session and recursively cleans up its descendants. The request uses freshly resolved `headers` and `auth`; failures are logged so an unreachable remote cannot block parent finalization.

A failed _start_ fails the call with `START_FAILED`, including a start refused because the two deployments use different task protocol versions (see [Upgrading remote agents](#upgrading-remote-agents)). Each request the parent sends a remote has a 30-second limit and does not follow redirects. A create request with no answer in time fails the call with `START_FAILED`, and a message to a working child with no answer in time fails that message with `AGENT_UNREACHABLE` while the child's current call continues. After a remote starts, a terminal failure callback fails the call with the remote's error (or `EXECUTION_FAILED` when none is supplied). Callback delivery runs as a durable step on the underlying workflow engine (see [Execution model & durability](../concepts/execution-model-and-durability)). A failed callback POST is rethrown rather than marking the call complete, so the engine retries it.

### Questions, approvals, and sign-in

A remote child inherits the parent session's capabilities, as a local child does. When the parent session can reach a person, a tool approval, a `ctx.ask()` question, or a connection sign-in prompt in the remote child surfaces on the parent's stream as `input.requested`, `approval.*`, or `authorization.*` with the `taskId` of the call that asked, and `input.resolved` follows once the request is resolved. Answer it on the parent session with `inputResponses`, or with plain text for the only pending question, exactly as for a local child. eve forwards the answer to the remote session as the answering principal when the definition forwards the caller identity. The remote child attributes the answer to that principal, the `responder` its [approval response policy](../human-in-the-loop#authorizing-approval-responses) checks, and keeps acting as the principal that started it. A sign-in completes on the remote deployment, whose connection callback the prompt links to. When the parent session cannot request input, such as a session a schedule started, the remote child's `ctx.ask()` questions resolve as `unavailable`.

When the remote child cannot deliver a question, an approval, or a resolution to the parent, for example while the parent session moves to another deployment and its callback route answers `503`, the child sends it again, in order, in a retried step before it waits for the answer. A question or approval the parent still does not take after those retries is dropped, and the call's time limit bounds the wait. A resolution is kept and sent again before the child next waits, so the parent does not keep waiting on a request the child already resolved. An event the parent refuses outright, such as one from another task protocol version, is dropped.

An answer that fails for a reason that may clear, such as a timeout, stays answerable on the parent. An answer that can never reach the remote child fails the call: with `AGENT_SESSION_ENDED` when the remote session no longer exists, and with `AGENT_UNREACHABLE` when the remote deployment now uses another task protocol version.

### Retries and lost callbacks

Retries on either side do not apply a call's work or its result twice:

- Every continue or steering request eve sends a remote child carries an `operationId` derived from the call, so the remote admits a retried request once.
- The parent applies each result the child reports once. The child numbers its answers, and the parent ignores an answer it already applied, even one that arrives after the call moved on to the child's next answer. A repeated callback is acknowledged with `202`, like the first. A callback that arrives after the parent session ended is answered `200` with `{"ok":true,"duplicate":true}`. The child treats any `2xx` as delivered, so it neither fails nor keeps retrying. While the parent session moves to another deployment, the callback route answers `503` and the child retries.
- A lost callback is recovered at the call's deadline. Before a remote call fails with `TIMED_OUT`, eve reads the remote session's latest result for that call once, from `GET /eve/v1/session/:childSessionId/reports/:callId`, with the definition's `auth` and `headers` and the parent's callback token in the `x-eve-callback-token` header. The remote keeps each result for the callback it was sent to and returns it only to a reader that presents that token; any other read, like a read for a call the child has not answered, gets `"report": null`. If the child's latest answer is one the parent has not applied, the call settles with it. Otherwise it fails with `TIMED_OUT`, and eve cancels the child's turn. The remote keeps a result larger than 50 KB for this read as the truncated text the caller's model would read (cut at 50 KB or 2,000 lines), so a result recovered this way reaches `task.settled` and `action.result` truncated.

## Upgrading remote agents

A remote agent and the agent that calls it must use the same task protocol version. The child side of a call keeps the call open until its own work finishes, forwards its questions and approvals, counts steering messages, and records its results for the parent's deadline read, so both sides must agree on the protocol. The version is currently `1`. A deployment reports it in the `x-eve-task-protocol` header of `GET /eve/v1/health` and as `taskProtocol` on accepted create and message responses. Create, message, and answer requests and every callback carry the sender's version as `taskProtocol`. Cancel and reset requests carry none, so a parent can always stop a child. Upgrade the calling deployment and each remote agent it calls together.

A call across mixed versions fails at once, in either direction, instead of waiting for the call's time limit:

- A remote agent on an older eve reports no version on its health route. The parent fails the call with `START_FAILED` before it creates a session there, so none of the remote's model or tools run:

  ```text
  Remote agent "billing" cannot be called: its deployment reports no task protocol version (it runs an older eve), and this deployment uses version 1. Upgrade so both deployments use the same task protocol version.
  ```

- A remote agent on the current eve refuses a call from an older parent, which sends a callback without a version, with `409` and `"code": "TASK_PROTOCOL_MISMATCH"`, so the older parent's call fails at start.
- A parent refuses a callback from another version with the same `409`. The child stops retrying it, and the call's time limit ends the parent's wait.

Sessions are not migrated across versions. When a session from an earlier release next runs, each background task that release left working fails with `STATE_LOST`, the model receives that result in a `task.result` message, and the session continues. Start the work again if it is still needed.

## What to read next

- Local delegation and the isolation boundary → [Subagents](../subagents)
- Securing the receiving deployment → [Auth & route protection](./auth-and-route-protection)
