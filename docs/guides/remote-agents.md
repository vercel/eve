---
title: "Remote Agents"
description: "Call another eve deployment as a subagent with defineRemoteAgent: same lowered tool shape, outbound auth, durable callback dispatch."
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
| `outputSchema`     | `StandardSchema \| JSON Schema`               | No       | none              | Structured return type the caller requires. Lowered to JSON Schema at compile time and enforced by the remote like any task-mode output schema.          |

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

## The lowered tool

A remote agent lowers to the same `{ message, outputSchema? }` tool shape as a local subagent. The parent packs everything the remote needs into `message`. The remote never sees the parent's history. Set `outputSchema` (here or per call) and the remote runs in task mode (a single-shot delegation that returns one structured result instead of an open conversation; see [Subagents](../subagents)), returning structured output as the tool result.

## Outbound auth

`auth` is an `OutboundAuthFn` from `eve/agents/auth` that attaches request headers to the outbound dispatch:

| Helper                          | Header                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `vercelOidc(opts?)`             | `Authorization: Bearer <Vercel OIDC token>` (deployment-to-deployment trust) |
| `bearer(token)`                 | `Authorization: Bearer <token>` (static or lazily resolved)                  |
| `basic({ username, password })` | `Authorization: Basic …`                                                     |

If you are calling another Vercel-deployed eve agent, reach for `vercelOidc()`. The remote verifies the OIDC token to authorize the caller. See [Auth & route protection](./auth-and-route-protection) for the receiving side.

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

The create-session request then carries the parent turn's `session.auth.current` and `session.auth.initiator` as a `forwardedPrincipal` body field (`initiator` is optional on the wire; when absent, the receiver seeds both from `current`). Only principal metadata crosses the wire — never tokens or credentials. The receiving deployment mints its own per-user credentials through its own connections.

Forwarding is explicit on both sides. The receiver names which forwarders it trusts with `eveChannel({ trustedForwarders })` (see [Auth & route protection](./auth-and-route-protection#accepting-forwarded-identity-from-another-deployment)); a receiver that refuses the forwarder — or has no `trustedForwarders` at all — rejects with a 403 and the dispatch fails. One caveat: a receiver on an eve version that predates principal forwarding drops the unknown field and runs the session as your app's service identity (per-user connections there fail with `principal_required`), so upgrade both deployments together when enabling forwarding. When the dispatching turn has no auth at all, the field is omitted and the call proceeds on transport trust alone.

## How remote dispatch and callbacks work

A local subagent runs inline. A remote one runs in its own deployment, so dispatch is asynchronous:

1. The parent starts a task-mode session on the remote's `POST /eve/v1/session`, passing a framework callback URL.
2. The parent turn parks (suspends durably without holding compute; see [Execution model & durability](../concepts/execution-model-and-durability)) until the remote posts a terminal callback.
3. When the callback arrives, the parent resumes and surfaces the result.

The parent stream carries the same `subagent.called`, `action.result`, and `subagent.completed` events as local delegation. For a remote call, `subagent.called.data.remote.url` records the target.

Cancelling the parent while a remote call is active sends an authenticated `POST /eve/v1/session/:childSessionId/cancel` to the remote and waits for that request to be accepted before the parent settles. eve resolves the remote's `headers` and `auth` again for every cancellation attempt, so rotating credentials work the same way as they do for session creation. Cancellation always uses the standard eve cancel path on `url`, even when `path` customizes only the create-session endpoint. The remote child reports `turn.cancelled` → `session.waiting` on its own stream; an older or unreachable remote is logged but cannot turn the parent's cancellation into a failure.

Both failure paths surface to the parent as a failed tool result, so the caller can explain or recover within the same session. A failed _start_ returns the error inline. A remote that starts and then fails posts a terminal failure callback, which the parent receives as an errored subagent result carrying the remote's error (or `REMOTE_AGENT_FAILED` when none is supplied). Terminal callback delivery runs as a durable step on the underlying workflow engine (see [Execution model & durability](../concepts/execution-model-and-durability)). A failed callback POST is rethrown rather than marking the task complete, so the engine retries it.

## What to read next

- Local delegation and the isolation boundary → [Subagents](../subagents)
- Have the model orchestrate remote agents programmatically → [Dynamic workflows](./dynamic-workflows)
- Securing the receiving deployment → [Auth & route protection](./auth-and-route-protection)
