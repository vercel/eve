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

| Parameter          | Type                    | Required | Default           | Description                                                                                                                                        |
| ------------------ | ----------------------- | -------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`              | `string`                | Yes      | n/a               | Base URL of the remote eve deployment. Compute runtime URLs in a dynamic definition (see [Runtime URLs](#runtime-urls)).                           |
| `description`      | `string`                | Yes      | n/a               | Model-visible delegation description.                                                                                                              |
| `auth`             | `OutboundAuthFn`        | No       | none              | Outbound auth hook from `eve/agents/auth`.                                                                                                         |
| `forwardPrincipal` | `boolean`               | No       | `false`           | Forward the dispatching turn's session principal to the remote deployment (see [Forwarding the caller identity](#forwarding-the-caller-identity)). |
| `headers`          | `HeadersValue`          | No       | none              | Static or lazily resolved request headers.                                                                                                         |
| `path`             | `string`                | No       | `/eve/v1/session` | Route appended to `url` for the create-session request.                                                                                            |
| `tool`             | `boolean \| "deferred"` | No       | `true`            | Expose the remote agent as a tool to the parent model. Set `false` to allow only `ctx.agent()` calls from authored workflow tools.                 |

## Dynamic remote agents

Wrap the file in `defineDynamic` when the target or its availability depends on
the current session. The function returns `defineRemoteAgent(...)` to expose it or `null` to omit it:

```ts title="agent/subagents/weather.ts"
import { defineDynamic, defineRemoteAgent } from "eve";

export default defineDynamic((ctx) =>
  ctx.session.auth.current?.attributes.region === "us"
    ? defineRemoteAgent({
        description: "Answers weather questions for US customers.",
        url: "https://us-weather-agent.example.com",
      })
    : null,
);
```

eve evaluates the function before each ordinary model call. `auth` and `headers` can close over
its context or memo results. They resolve before each outbound request; credentials are not
memo results and must not be stored in them.

```ts title="agent/subagents/finance.ts"
import { defineDynamic, defineRemoteAgent } from "eve";
import { mintFinanceToken } from "../lib/finance";

export default defineDynamic((ctx) => {
  const tenant = ctx.session.auth.current?.attributes.tenant;
  return typeof tenant === "string"
    ? defineRemoteAgent({
        description: "Analyzes the tenant's financial data.",
        url: "https://finance-agent.example.com",
        auth: async () => ({
          headers: { authorization: `Bearer ${await mintFinanceToken(tenant)}` },
        }),
      })
    : null;
});
```

A child keeps the parent context and memo results used to select its remote configuration.
Later messages, answers, cancellation, reset, and stream reads use that original selection when
rebuilding transport credentials. Only saved memo results are available: a missing result or a
changed child name or URL fails before credentials are sent. `ctx.messages()` is unavailable
during this reconstruction, including when eve opens the child; keep conversation-based
selection inside a memo. This does not change the per-message caller identity described in
[Forwarding the caller identity](#forwarding-the-caller-identity). See
[Dynamic capabilities](./dynamic-capabilities#dynamic-subagents) for the memo rules.

## Runtime URLs

A static `url` is read at compile time. When an environment variable supplies the URL only at runtime, compute it inside `defineDynamic`:

```ts title="agent/subagents/weather.ts"
import { defineDynamic, defineRemoteAgent } from "eve";

export default defineDynamic(() =>
  defineRemoteAgent({
    url: process.env.WEATHER_AGENT_URL ?? "https://weather-agent.example.com",
    description: "Answers weather, temperature, forecast, wind, rain, and snow questions.",
  }),
);
```

`url` must be a non-empty string. `auth` and `headers` remain lazy callbacks resolved per request.

## Calling a remote agent

By default, a remote agent is another subagent tool to the model. The model calls it the same way it calls a local subagent, with a `message` and an optional `taskId`. Set `tool: false` when an authored workflow tool should be the only model-facing routing surface; the workflow can still call the remote agent by its path-derived name through `ctx.agent()`. Set `tool: "deferred"` to keep the remote agent out of the model's tool list while the model can still find it with `eve__search` and call it with `eve__tool`. The message must carry the full task, including any context the remote agent needs, because it never receives the parent's conversation history.

To require structured output, open a session with the remote agent from an authored workflow tool with `ctx.agent(name)` and pass `outputSchema` to `send()`. The schema applies to that turn, the structured value is the response's `data`, and the session accepts follow-up messages until the workflow run finishes. See [Delegate work: `ctx.agent`](../tools/workflows#delegate-work-ctxagent).

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

The create-session request carries the parent turn's `session.auth.current` and `session.auth.initiator` as a `forwardedPrincipal` body field (`initiator` is optional on the wire; when absent, the receiver seeds both from `current`). A continuation by `taskId` carries the `session.auth.current` of the call that continues the task; the remote session keeps its original `auth.initiator`. Only principal metadata crosses the wire — never tokens or credentials. The receiving deployment resolves its own per-user credentials through its own connections.

This makes caller authority turn-scoped even when the remote child session is persistent. If Alice starts the child and Bob later continues it with its `taskId`, the follow-up runs with Bob as `auth.current`, not Alice. If the parent turn's auth is `null`, a local child clears `auth.current`, while a remote child uses the freshly verified transport principal; neither inherits Alice. eve's in-step bearer cache is also keyed by the resolved principal and is not serialized across steps. The external authorization provider may preserve each user's server-side OAuth grant, but a later turn can resolve only the grant belonging to its own `auth.current` principal.

Identity forwarding does not make a persistent session private to one caller. Conversation history, tool outputs, and other child-session state still persist. If those values must not be visible across users, give each user a distinct child session or enforce that ownership at the application boundary.

Forwarding identity is explicit on both sides. The receiver names which deployments it trusts with `eveChannel({ trustedForwarders })` and can limit each one to the principals it may assert (see [Auth & route protection](./auth-and-route-protection#accepting-forwarded-identity-from-another-deployment)); refusing the forwarder or what it asserts rejects a forwarded principal with a 403. The same trust decision covers parent session lineage and, with principal forwarding, trace-content constraints.

## Trace propagation

A remote child starts its own trace with a root `invoke_agent` span. When caller
trace context is available, the first turn links to the dispatch span with
`eve.link.type=agent.dispatch`. The receiving deployment applies its sampler.
Later turns start new traces without the original dispatch link. The first turn
of a local child can use the remote agent's trace as a nested span.

Use `gen_ai.conversation.id` to find all turns and child sessions for one
conversation. The child has its own session ID, message history, and agent
state. Trace context identifies related work. It does not give authorization.
See [OpenTelemetry](../observability/otel#trace-topology) for the trace structure.

eve carries parent session lineage separately. The receiver accepts it only
when `trustedForwarders` approves the authenticated caller; otherwise, trace
correlation continues without it.

On Vercel, a remote agent's spans and its local subagents' spans carry the
remote session's ID as `vercel.session_id`, so the receiving project groups
them as their own session. `gen_ai.conversation.id` still names the sender's
conversation, and the remote agent's `agent.parent_run.id` names the calling
session.

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

A remote subagent call runs a child session in the remote deployment as a task:

1. The parent starts a persistent conversation session on the remote's `POST /eve/v1/session`, passing a framework callback URL.
2. The remote accepts the child and runs its turn while the task works.
3. The callback delivers the child's reply, which becomes the task's result.

The parent stream carries the same `task.started`, `child.opened`, and `call.settled` facts as local delegation. A remote child's deployment binding is private: only the parent's stream proxy reads it.

Clients follow a remote child through the parent. [`session.agent(opened).stream()`](./client/streaming#follow-a-subagent) reads the `child.opened` event's `stream` path, a route on the parent deployment. The parent verifies that its session recorded the child for that tool call, resolves the remote agent's `auth` and `headers`, and relays the child's stream. A browser never calls the remote deployment or holds its credentials; it only needs access to the parent session.

Cancelling the parent turn or the agent task with `eve__task_cancel` also cancels the remote child's current turn. eve resolves the remote's `headers` and `auth` again for every cancellation attempt, so rotating credentials work the same way as they do for session creation. Cancellation always uses the standard eve cancel path on `url`, even when `path` customizes only the create-session endpoint. The remote child reports `turn.settled` with `outcome: "cancelled"` on its own stream; an older or unreachable remote is logged but cannot turn the parent's cancellation into a failure.

When the workflow run that opened a remote child finishes, eve sends an authenticated `POST /eve/v1/session/:childSessionId/reset` for it. An agent task's run finishes when the parent session ends. Reset retires the parked remote session and recursively cleans up its descendants. The request uses freshly resolved `headers` and `auth`; failures are logged so an unreachable remote cannot block parent finalization.

The parent names its remote agent protocol version when it creates the child, and the remote
answers with the version it serves. This release serves protocols 2 and 3. A protocol-3 parent
accepts a protocol-2 remote's results and failures, but cannot follow its live stream. It relays that
remote's approvals, questions, and sign-ins to the person it serves, as described below.
A protocol-3 remote returns results and failures to callers on protocol 2, but cannot relay
approvals, questions, or sign-ins to them: a turn that needs a person fails with upgrade guidance
instead of waiting on an unreachable prompt. Unsupported versions, including protocol 1 from
eve 0.66 through 0.68, fail at start with an error naming both versions.

A receiver on an earlier supported protocol can reject a new caller's create request
before admission. After an explicit `409 REMOTE_AGENT_PROTOCOL_MISMATCH` rejection,
eve makes one request with that receiver's supported version and fresh credentials.
It does not negotiate after an accepted response, an unreadable receipt, a rejection
that names a session, or an unsupported version.

A parent that negotiated protocol 2 relays that child's approvals, questions, and
sign-ins like a protocol-3 child's. The person answers them in the parent's session,
and their answers return in the form the child accepts. The child still decides who
may answer: an answer it turns away, such as one from a responder its approval policy
refuses, leaves the approval open. The child reports how its approvals and sign-ins
settle. It doesn't report how a question or budget prompt settles, so the parent
settles those once the child accepts the answer. Cancelling the parent's call withdraws
what it mirrored.

### Upgrading callers and remote agents

Upgrade callers before the remote agents they call, or both together. A caller on this release
relays a protocol-2 remote agent's approvals, questions, and sign-ins, but a remote agent on this
release can't relay them to a protocol-2 caller.

A remote child's callback goes to the parent's current production deployment, not to the
deployment that started the call; the parent's own sessions stay on the deployment that started
them. Every callback URL a parent gives a child names the protocol they agreed
(`eveRemoteProtocol`), and the parent reads a child's callbacks by that protocol. A URL that names
none comes from a parent run started before v27. When an earlier child's approval, question, or
sign-in for such a run reaches an upgraded deployment, the deployment passes it to that run as is,
so the run receives it as it did before the upgrade.

### Retries and acknowledgements

Each follow-up message and each set of answers a parent sends a protocol-3 child carries an
`idempotencyKey` named by the parent's own durable step. When the child accepts a request but the
parent doesn't hear back, the parent's retry is the same delivery: the child admits it once and
returns the original receipt. Protocol-2 children don't accept the field, so the parent sends
it only to protocol-3 children.

A failed start fails the call immediately. After a remote starts, a terminal failure callback
fails the call with the remote's error. Terminal callback delivery runs as a durable step on the
underlying workflow engine (see [Execution model & durability](../concepts/execution-model-and-durability)).
A failed callback POST is rethrown so the engine retries it. A parent's callback route answers
`404` with `code: "CALLBACK_NOT_PENDING"` when nothing waits on the callback: the parent already
took the result, for example from a delivery whose acknowledgement was lost, or stopped waiting for
it. The child retries that answer for a few seconds, in case the parent hasn't yet registered the
reply it sent the token for, then logs it and keeps its session, rather than failing it.

If a remote accepts the create request but its response has an incompatible
protocol or an unreadable body, the work may have completed. eve stops workflow
retries and reports that uncertainty. A protocol mismatch includes the accepted
remote session ID so you can inspect the outcome before sending another request.
Upgrading the remote does not undo work that it already performed. An unsupported version, or a rejection of the single negotiated request,
remains a compatibility error.

## What to read next

- Local delegation and the isolation boundary → [Subagents](../subagents)
- Securing the receiving deployment → [Auth & route protection](./auth-and-route-protection)
