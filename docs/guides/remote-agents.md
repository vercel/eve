---
title: "Remote Agents"
description: "Call another eve deployment as a subagent with defineRemoteAgent: the same tool call as a local subagent, with outbound auth and durable callbacks."
---

A remote agent is a separately deployed eve agent that your agent calls as a subagent. Define one with `defineRemoteAgent` in a file under `agent/subagents/`. The tool name comes from the file path, so `agent/subagents/weather.ts` is the `weather` tool.

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

| Parameter          | Type                                          | Required | Default           | Description                                                                                                                                                                         |
| ------------------ | --------------------------------------------- | -------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`              | `string \| (() => string \| Promise<string>)` | Yes      | n/a               | Base URL of the remote eve deployment. Pass a function to [read it at runtime](#runtime-urls).                                                                                      |
| `description`      | `string`                                      | Yes      | n/a               | What the parent model reads to decide when to delegate.                                                                                                                             |
| `auth`             | `OutboundAuthFn`                              | No       | none              | Outbound auth from `eve/agents/auth`.                                                                                                                                               |
| `forwardPrincipal` | `boolean`                                     | No       | `false`           | Send the calling turn's user identity to the remote deployment. See [Forwarding the caller identity](#forwarding-the-caller-identity).                                              |
| `headers`          | `HeadersValue`                                | No       | none              | Request headers, static or resolved for each request.                                                                                                                               |
| `path`             | `string`                                      | No       | `/eve/v1/session` | Route appended to `url` to create the remote session.                                                                                                                               |
| `tool`             | `boolean \| "deferred"`                       | No       | `true`            | `false` lets only authored workflow tools call it, through `ctx.agent()`. `"deferred"` keeps it out of the tool list but findable with `eve__search` and callable with `eve__tool`. |

## Calling a remote agent

The model calls a remote agent like a local subagent, with a `message` and an optional `taskId`. Put the full task and context in the message, because the remote agent never sees the parent's conversation.

A workflow tool calls the remote agent by its file name through `ctx.agent(name)`. For structured output, pass `outputSchema` to `send()` and read the value from the response's `data`. See [Delegate work: `ctx.agent`](../tools/workflows#delegate-work-ctxagent).

## Outbound auth

Use `vercelOidc()` from `eve/agents/auth` when one Vercel-deployed eve agent calls another, as in the first example.

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

If [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection) is on for the receiving project, also allow the calling project and environment in [Trusted Sources](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources). Calls between projects must pass both the eve subject allowlist and Trusted Sources.

## Forwarding the caller identity

Outbound auth proves which _deployment_ is calling, so by default the remote session runs as your app, not as the end user. Work that must run as the user on the remote, such as per-user [Vercel Connect](./auth-and-route-protection#tool-and-connection-auth), needs the user's identity. Set `forwardPrincipal: true` to send it:

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

- When eve creates the remote session, it sends the parent turn's `session.auth.current` and `session.auth.initiator`. When `initiator` is absent, the receiver uses `current` for both.
- A follow-up with `taskId` sends the follow-up call's `session.auth.current`. The remote session keeps its original `auth.initiator`.
- eve sends only identity metadata, never tokens or credentials. The receiver gets per-user credentials through its own connections.

Each turn runs as its own caller, even in a child session that persists. If Alice starts the child and Bob continues it with its `taskId`, the follow-up runs with Bob as `auth.current`. If the parent turn's auth is `null`, a local child clears `auth.current`, and a remote child runs as the verified calling deployment. Neither runs as Alice. A later turn can use only the OAuth grant of its own `auth.current` user.

Forwarding doesn't make a child session private to one caller: its conversation history, tool outputs, and other state persist. If they must not be visible across users, give each user a separate child session or check ownership in your application.

The receiver must opt in. It names trusted deployments with `eveChannel({ trustedForwarders })` and can limit which users each one may assert (see [Auth & route protection](./auth-and-route-protection#accepting-forwarded-identity-from-another-deployment)). A refused deployment or identity gets a 403. The same trust decision covers the parent session link and, with forwarding on, trace-content limits.

## Dynamic remote agents

Wrap the definition in `defineDynamic` when the target or whether to offer it depends on the session. Return `defineRemoteAgent(...)` to offer it or `null` to hide it:

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

eve runs the function before each ordinary model call. `auth` and `headers` can use its context or memo results, and they run before each outbound request. Don't store credentials in memo results.

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

A child keeps the parent context and memo results that chose its configuration:

- Later messages, answers, cancellation, ending the session, and stream reads rebuild the credentials from that original context, not from a newer caller.
- If a memo result is missing, or the child's name or URL changed, the request fails before eve sends credentials.
- `ctx.messages()` is unavailable during this rebuild, including when eve opens the child, so keep decisions based on the conversation inside a memo.

Each message still runs as its own caller, as described in [Forwarding the caller identity](#forwarding-the-caller-identity). See [Dynamic capabilities](./dynamic-capabilities#memo-rules) for the memo rules.

## Runtime URLs

eve reads a string `url` at build time. When an environment variable supplies the URL only at runtime, pass a function. It returns a string or a promise, and eve calls it when it resolves the runtime agent graph:

```ts title="agent/subagents/weather.ts"
import { defineRemoteAgent } from "eve";

export default defineRemoteAgent({
  url: () => process.env.WEATHER_AGENT_URL ?? "https://weather-agent.example.com",
  description: "Answers weather, temperature, forecast, wind, rain, and snow questions.",
});
```

The resolved `url` must be a non-empty string. To choose which agent to offer, or whether to offer one, from the current session, use [`defineDynamic`](#dynamic-remote-agents).

## Trace propagation

A remote child starts its own trace with a root `invoke_agent` span, sampled by the receiving deployment. When the caller's trace context is available, the child's first turn links to the calling span with `eve.link.type=agent.dispatch`. Later turns start new traces without that link. The remote agent's local children can nest their first turn under its trace.

Use `gen_ai.conversation.id` to find all turns and child sessions for one conversation. Trace context only links related work; it doesn't authorize anything. See [OpenTelemetry](../observability/otel#trace-topology) for the trace structure.

The receiver accepts the parent session link only when `trustedForwarders` approves the caller. Otherwise, traces still correlate without it.

On Vercel, spans from a remote agent and its local subagents carry the remote session's ID as `vercel.session_id`. The receiving project groups them as their own session. `gen_ai.conversation.id` still names the sender's conversation, and `agent.parent_run.id` names the calling session.

## Preserving trace content

With `forwardPrincipal: true`, a sampled remote call forwards its audience and the most input and output content the next hop may record, as [W3C Baggage](https://www.w3.org/TR/baggage/). The receiver uses this policy only from a trusted caller:

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { vercelOidc, vercelSubject } from "eve/channels/auth";

export default eveChannel({
  auth: [vercelOidc()],
  trustedForwarders: (forwarder) =>
    forwarder.subject === vercelSubject({ teamSlug: "acme", projectName: "router" }),
});
```

The request must include a callback and a valid sampled `traceparent`; `trustedForwarders` is the authorization boundary. An accepted audience replaces the one the receiver's channel would assign.

The receiver combines the forwarded limit with its own trace policy. Each hop can capture less content but can't restore what an earlier hop removed. A missing, malformed, unsampled, or untrusted value falls back to metadata-only tracing.

## How remote dispatch and callbacks work

A remote subagent call runs a child session on the remote deployment as a task:

1. The parent starts a conversation session on the remote's `POST /eve/v1/session` and passes a callback URL.
2. The remote accepts the child and runs its turn while the task works.
3. The callback returns the child's reply, which becomes the task's result.

The parent stream shows the same `task.started`, `child.opened`, and `call.settled` events as local delegation.

The callback URL must use `http` or `https` and reach the parent at a public address. The remote refuses a callback host that is, or resolves to, a private, link-local, or reserved IP address, and a refused callback fails without retries. Loopback hosts such as `localhost` and `127.0.0.1` work only when the remote runs `eve dev` or `vercel dev`. A parent and remote on a private network can't exchange callbacks.

A callback URL carries only the message's callback capability, never the parent's deployment protection bypass secret. To let callbacks reach a parent behind Vercel Deployment Protection, configure Trusted Sources on the parent to admit the remote's project and environment.

On the remote deployment, set `EVE_CALLBACK_TRUSTED_ORIGINS` to a comma-separated list of parent HTTPS origins, such as `https://parent.example.com`. Each entry is an exact origin, or starts with a `*.` label as described below. The remote attaches its own short-lived Vercel OIDC token only to those origins and to its own deployment origins. An exact entry doesn't trust other ports or subdomains. Keep the remote's Vercel OIDC token available at runtime. Callbacks don't follow redirects.

Outside production, a parent's callback URL uses its generated deployment URL, which changes with every deployment. If you serve those deployments under a domain you control, trust them with a leading `*.` label, such as `https://*.preview.example.com`:

- The wildcard matches exactly one label: `parent-abc123.preview.example.com`, but not `preview.example.com` or `a.b.preview.example.com`.
- The port must still match.
- At least two labels must follow the wildcard, and an entry with a trailing dot is rejected.
- eve rejects `https://*.vercel.app`, because every Vercel deployment shares that domain. It doesn't detect other shared domains, such as `*.github.io`.

Each origin you add receives a bearer credential for the remote project's identity, not a token scoped to the callback. Until the token expires, that parent can replay it against any service, deployment protection rule, or federated cloud role that accepts the identity. List only parents you trust to act as the remote project, and use a wildcard only when you control every host under it.

When either side isn't on Vercel, make the parent's callback route reachable through your hosting policy. eve never forwards a deployment-wide credential to the remote.

Clients follow a remote child through the parent. [`session.agent(opened).stream()`](./client/streaming#follow-a-subagent) reads the `child.opened` event's `stream` path, a route on the parent deployment. The parent checks that the child belongs to that tool call, then relays the child's stream with the remote agent's `auth` and `headers`. A browser never calls the remote deployment or holds its credentials.

Cancelling the parent turn, or the task with `eve__task_cancel`, cancels the remote child's current turn. The child reports `turn.settled` with `outcome: "cancelled"` on its own stream. Each cancel resolves `headers` and `auth` again and uses the standard eve cancel route on `url`, even when `path` is customized. If the remote is older or unreachable, eve logs it, and the parent's cancel still succeeds.

When the workflow run that opened a remote child finishes, eve sends an authenticated request that ends the remote session and its descendants. An agent task's run finishes when the parent session ends. The request uses freshly resolved `headers` and `auth`. eve logs failures, so an unreachable remote can't block the parent from finishing.

The parent names its remote agent protocol version when it creates the child, and the remote answers with the version it serves. eve serves protocols 2 and 3:

| Parent | Remote | Behavior                                                                                                                                                   |
| ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3      | 2      | Results and failures return, and approvals, questions, and sign-ins relay to the person. The parent can't follow the child's live stream.                  |
| 2      | 3      | Results and failures return. Approvals, questions, and sign-ins can't relay, so a turn that needs a person fails with upgrade guidance instead of waiting. |

Unsupported versions fail at start with an error naming both versions.

A receiver on an older protocol can reject the create request with `409 REMOTE_AGENT_PROTOCOL_MISMATCH` before it accepts the child. eve then sends one more request with that receiver's version and fresh credentials. eve doesn't try again after an accepted response, an unreadable receipt, a rejection that names a session, or an unsupported version.

With a protocol-2 child, the person answers relayed requests in the parent's session. The child still decides who may answer, so an answer its approval policy refuses leaves the approval open. The child reports when approvals and sign-ins end, but not questions or budget prompts. The parent closes those when the child accepts the answer. Cancelling the parent's call withdraws the relayed requests.

### Upgrading callers and remote agents

Upgrade callers before the remote agents they call, or both together, because a protocol-3 remote can't relay approvals, questions, or sign-ins to a protocol-2 caller.

A remote child's callback goes to the parent's current production deployment, not the deployment that started the call. The parent's own sessions stay on the deployment that started them.

### Retries and acknowledgements

Each follow-up message and set of answers sent to a protocol-3 child carries an `idempotencyKey`. If the child accepts a request but the parent never gets the reply, the child accepts the retry once and returns the original receipt. Protocol-2 children don't receive the key.

A failed start fails the call immediately. After a remote starts, a final failure callback fails the call with the remote's error. eve retries a failed final callback request (see [Execution model & durability](../concepts/execution-model-and-durability)).

A parent's callback route answers `404` with `code: "CALLBACK_NOT_PENDING"` when nothing waits on the callback. Either the parent already took the result, for example after a lost acknowledgement, or it stopped waiting. The child retries for a few seconds in case the parent hasn't registered the reply yet, then logs it and keeps its session.

If a remote accepts the create request but its response has an incompatible protocol or an unreadable body, the work may have finished. eve stops workflow retries and reports that the outcome is unknown. A protocol mismatch includes the accepted remote session ID, so you can check the outcome before you send another request. Upgrading the remote doesn't undo work it already did. An unsupported version, or a rejection of the one retried request, is a compatibility error.

## What to read next

- Local delegation and the isolation boundary → [Subagents](../subagents)
- Securing the receiving deployment → [Auth & route protection](./auth-and-route-protection)
