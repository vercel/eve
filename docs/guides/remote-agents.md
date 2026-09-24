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

This makes caller authority turn-scoped even when the remote child session is persistent. If Alice starts the child and Bob later continues it, the follow-up runs with Bob as `auth.current`, not Alice. If the parent turn's auth is `null`, a local child clears `auth.current`, while a remote child uses the freshly verified transport principal; neither inherits Alice. eve's in-step bearer cache is also keyed by the resolved principal and is not serialized across steps. The external authorization provider may preserve each user's server-side OAuth grant, but a later turn can resolve only the grant belonging to its own `auth.current` principal.

Identity forwarding does not make a persistent session private to one caller. Conversation history, tool outputs, and other child-session state still persist. If those values must not be visible across users, give each user a distinct child session or enforce that ownership at the application boundary.

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

1. The parent starts a persistent conversation session on the remote's `POST /eve/v1/session`, passing a framework callback URL.
2. The remote child runs its turn.
3. The child posts its answer to the callback URL, and the answer becomes the tool result for the parent's call.

The parent stream carries the same `task.started`, `action.result`, and `task.settled` events as local delegation. For a remote call, `task.started.data.child.remote.url` records the target.

In an interactive root session, the model can run a remote agent call in the background with `background: true`, exactly as with a local subagent: the call returns a receipt, and the remote child's answer arrives through the same callback and reaches the model later in a `task.result` message. See [Run a call in the background](../subagents#run-a-call-in-the-background). Passing the `agentId` of a remote child that is still working sends its message with a continue request that carries no callback and `turnPolicy: "steer"`, so the remote child applies it to its current turn and answers through the callback it already has. When the definition forwards the caller identity, that request forwards the principal whose call started the child's current work, not the steering turn's principal. Upgrade the remote deployment to the same eve version before relying on this behavior.

Clients follow a remote child through the parent. [`session.streamSubagent()`](./client/streaming#follow-a-subagent) reads `task.started.data.child.streamPath`, a route on the parent deployment. The parent verifies that the child belongs to that session, resolves the remote agent's `auth` and `headers`, and relays the child's stream. A browser never calls the remote deployment or holds its credentials; it only needs access to the parent session.

Each remote call has the same time limit as a local one: 2 hours of active time unless you set `timeout` on the definition, in milliseconds, or `false` to keep only the parent session's lifetime as the limit. A call still working at the limit fails with `TIMED_OUT`, and eve sends the remote child a cancellation. A remote agent that typically runs longer needs a larger `timeout`:

```ts title="agent/subagents/content.ts"
import { defineRemoteAgent } from "eve";

export default defineRemoteAgent({
  url: () => process.env.CONTENT_AGENT_URL ?? "https://content-agent.example.com",
  description: "Drafts long-form content. Typical runs take 5 to 15 minutes.",
  timeout: 3 * 60 * 60_000,
});
```

Cancelling the parent turn cancels the remote child's current turn. eve resolves the remote's `headers` and `auth` again for every cancellation attempt, so rotating credentials work the same way as they do for session creation. Cancellation always uses the standard eve cancel path on `url`, even when `path` customizes only the create-session endpoint. The remote child reports `turn.cancelled` → `session.waiting` on its own stream; an older or unreachable remote is logged but cannot turn the parent's cancellation into a failure.

When the parent session ends, eve sends an authenticated `POST /eve/v1/session/:childSessionId/reset` for each remote child. Reset retires the parked remote session and recursively cleans up its descendants. The request uses freshly resolved `headers` and `auth`; failures are logged so an unreachable remote cannot block parent finalization.

A remote child cannot ask the parent's user for input or authorization yet. If a remote child's turn stops for a tool approval, a `ctx.ask()` question, or a connection sign-in, the child fails and the parent's call fails with its error instead of waiting. Configure tools and connections on the remote deployment so the turn can finish without a person.

A failed _start_ fails the tool call. After a remote starts, a terminal failure callback fails the call with the remote's error (or `REMOTE_AGENT_FAILED` when none is supplied). Terminal callback delivery runs as a durable step on the underlying workflow engine (see [Execution model & durability](../concepts/execution-model-and-durability)). A failed callback POST is rethrown rather than marking the call complete, so the engine retries it.

## What to read next

- Local delegation and the isolation boundary → [Subagents](../subagents)
- Securing the receiving deployment → [Auth & route protection](./auth-and-route-protection)
