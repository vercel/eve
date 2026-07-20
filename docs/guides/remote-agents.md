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

| Parameter      | Type                                          | Required | Default           | Description                                                                                                                                              |
| -------------- | --------------------------------------------- | -------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`          | `string \| (() => string \| Promise<string>)` | Yes      | n/a               | Base URL of the remote eve deployment to call. A string is baked at compile time; a function is resolved at runtime (see [Runtime URLs](#runtime-urls)). |
| `description`  | `string`                                      | Yes      | n/a               | Model-visible delegation description.                                                                                                                    |
| `auth`         | `OutboundAuthFn`                              | No       | none              | Outbound auth hook from `eve/agents/auth`.                                                                                                               |
| `headers`      | `HeadersValue`                                | No       | none              | Static or lazily resolved request headers.                                                                                                               |
| `path`         | `string`                                      | No       | `/eve/v1/session` | Route appended to `url` for the create-session request.                                                                                                  |
| `outputSchema` | `StandardSchema \| JSON Schema`               | No       | none              | Structured return type the caller requires. Lowered to JSON Schema at compile time and enforced by the remote like any task-mode output schema.          |

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
