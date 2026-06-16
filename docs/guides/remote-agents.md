---
title: "Remote Agents"
description: "Call another Eve deployment as a subagent with defineRemoteAgent: same lowered tool shape, outbound auth, durable callback dispatch."
---

Sometimes the specialist you want to delegate to isn't a directory in your repo, it's a separately owned agent living behind its own URL. `defineRemoteAgent` lets you call another Eve deployment as if it were a local subagent.

The file lives under `agent/subagents/`, so its tool name is still derived from the path. There's no `name` field.

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

- `url`: the remote Eve deployment root. Required.
- `description`: the model-visible delegation description. Required.
- `auth`: optional outbound auth hook from `eve/agents/auth`.
- `headers`: optional static or lazy request headers.
- `path`: optional session-create path; defaults to `/eve/v1/session`.
- `outputSchema`: optional structured return type the caller requires (lowered to JSON Schema at compile time and enforced by the remote like any task-mode output schema).

## The lowered tool

A remote agent lowers to the same `{ message, outputSchema? }` tool shape as a local subagent. The parent packs everything the remote needs into `message`; the remote never sees the parent's history. Set `outputSchema` (here or per call) and the remote runs in task mode, returning structured output as the tool result.

## Outbound auth

`auth` is an `OutboundAuthFn` from `eve/agents/auth`. It attaches request headers to the outbound dispatch:

| Helper                          | Header                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `vercelOidc(opts?)`             | `Authorization: Bearer <Vercel OIDC token>` (deployment-to-deployment trust) |
| `bearer(token)`                 | `Authorization: Bearer <token>` (static or lazily resolved)                  |
| `basic({ username, password })` | `Authorization: Basic …`                                                     |

If you're calling another Vercel-deployed Eve agent, reach for `vercelOidc()`: the remote verifies the OIDC token to authorize the caller. See [Auth & route protection](./auth-and-route-protection) for the receiving side.

## Callback / park dispatch

A local subagent runs inline. A remote one runs in its own deployment, so dispatch has to be asynchronous:

1. The parent starts a task-mode session on the remote's `POST /eve/v1/session`, passing a framework callback URL.
2. The parent turn parks durably until the remote posts a terminal callback, holding no compute while it waits.
3. When the callback arrives, the parent resumes and surfaces the result.

The parent stream carries the same `subagent.called`, `action.result`, and `subagent.completed` events as local delegation. For a remote call, `subagent.called.data.remote.url` records the target. A failed _start_ comes back as a failed tool result, so the caller can explain or recover within the same session. Terminal callback delivery runs as a durable Workflow step on the callee: a failed callback POST is rethrown rather than marking the task complete, which puts redelivery under Workflow retry policy.

## What to read next

- Local delegation and the isolation boundary → [Subagents](../subagents)
- Have the model orchestrate remote agents programmatically → [Dynamic workflows](./dynamic-workflows)
- Securing the receiving deployment → [Auth & route protection](./auth-and-route-protection)
