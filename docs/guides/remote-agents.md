---
title: "Remote Agents"
description: "Call another eve deployment as a subagent with defineRemoteAgent: same tool call as a local subagent, outbound auth, durable callback dispatch."
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

## Dynamic remote agents

Wrap the file in `defineDynamic` when the target or its availability depends on
the current session. Return `defineRemoteAgent(...)` to expose it and nil to
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

To the model, a remote agent is another subagent tool. You call it the same way you call a local subagent, with a `message` and an optional `outputSchema`. The message must carry the full task, including any context the remote agent needs, because it never receives the parent's conversation history.

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

Forwarding is explicit on both sides. The receiver names which forwarders it trusts with `eveChannel({ trustedForwarders })` (see [Auth & route protection](./auth-and-route-protection#accepting-forwarded-identity-from-another-deployment)); a receiver that refuses the forwarder — or has no `trustedForwarders` at all — rejects with a 403 and the dispatch fails.

> ⚠️ **Upgrade both deployments before resuming persistent remote sessions.** A sender with continuation forwarding includes `forwardedPrincipal` on each authenticated follow-up. A receiver that supports forwarding only on session creation rejects that continuation with HTTP 400. eve does not retry without the field because that would run the follow-up as the transport service principal and silently change caller authority. The parent retains the child handle after this failure, so you can retry the same session after upgrading the receiver.

A receiver on an eve version that predates all principal forwarding may instead drop the unknown field and run the session as your app's service identity; per-user connections there fail with `principal_required`. On remote requests where the dispatching turn has no auth, the field is omitted and the call proceeds on transport trust alone.

## Preserving trace content

With `forwardPrincipal: true`, a sampled trace carries its original audience and the maximum content the next hop may record. For example, `eve.audience=private;ceiling=i0o1` allows outputs but not inputs. eve sends this as [W3C Baggage](https://www.w3.org/TR/baggage/).

The receiver uses it only after `trustedForwarders` accepts the authenticated calling deployment:

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { vercelOidc, vercelSubject } from "eve/channels/auth";

export default eveChannel({
  auth: [vercelOidc()],
  trustedForwarders: (forwarder) =>
    forwarder.subject === vercelSubject({ teamSlug: "acme", projectName: "router" }),
});
```

The request must also include a callback and a valid sampled `traceparent`. Those fields identify a remote call, but they do not establish trust. `trustedForwarders` is the authorization boundary.

The receiver combines the incoming ceiling with its own trace policy. Each hop may narrow the result, but it cannot restore inputs or outputs removed earlier. The original audience stays the same across remote and local subagent hops. Public origins may include content by default; private and unknown origins stay metadata-only unless both deployments explicitly allow them.

The live delivery audience still matters. An unknown callback delivery, or one matching the origin, uses the session decision. A different explicit audience applies its own hard ceiling, so a private delivery stays redacted even when the trace began in public.

Missing, malformed, duplicate, unsampled, untrusted, and mixed-version assertions fall back to metadata-only tracing. Dropped traces use only the unsampled trace flag. The decision is fixed when the remote session starts and reused by continuations. Agent Runs shows Workflow content only when both inputs and outputs are allowed.

## How remote dispatch and callbacks work

A local subagent runs inline. A remote one runs in its own deployment, so dispatch is asynchronous:

1. The parent starts a persistent conversation session on the remote's `POST /eve/v1/session`, passing a framework callback URL.
2. The parent turn parks (suspends durably without holding compute; see [Execution model & durability](../concepts/execution-model-and-durability)) until the remote posts a terminal callback.
3. When the callback arrives, the parent resumes and surfaces the result.

The parent stream carries the same `subagent.called`, `action.result`, and `subagent.completed` events as local delegation. For a remote call, `subagent.called.data.remote.url` records the target.

Cancelling the parent while a remote call is active sends an authenticated `POST /eve/v1/session/:childSessionId/cancel` to the remote and waits for that request to be accepted before the parent settles. eve resolves the remote's `headers` and `auth` again for every cancellation attempt, so rotating credentials work the same way as they do for session creation. Cancellation always uses the standard eve cancel path on `url`, even when `path` customizes only the create-session endpoint. The remote child reports `turn.cancelled` → `session.waiting` on its own stream; an older or unreachable remote is logged but cannot turn the parent's cancellation into a failure.

When the parent session ends, eve sends an authenticated `POST /eve/v1/session/:childSessionId/reset` for each remote child. Reset retires the parked remote session and recursively cleans up its descendants. The request uses freshly resolved `headers` and `auth`; failures are logged so an unreachable remote cannot block parent finalization.

Both failure paths surface to the parent as a failed tool result, so the caller can explain or recover within the same session. A failed _start_ returns the error inline. A remote that starts and then fails posts a terminal failure callback, which the parent receives as an errored subagent result carrying the remote's error (or `REMOTE_AGENT_FAILED` when none is supplied). Terminal callback delivery runs as a durable step on the underlying workflow engine (see [Execution model & durability](../concepts/execution-model-and-durability)). A failed callback POST is rethrown rather than marking the task complete, so the engine retries it.

## What to read next

- Local delegation and the isolation boundary → [Subagents](../subagents)
- Have the model orchestrate remote agents programmatically → [Workflow tool](../concepts/built-in-tools#workflow-tool)
- Securing the receiving deployment → [Auth & route protection](./auth-and-route-protection)
