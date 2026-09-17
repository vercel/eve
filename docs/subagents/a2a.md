---
title: "A2A Subagents"
description: "Delegate work to external A2A agents using eve's durable subagent lifecycle and shared authorization."
---

Use `defineA2AAgent` to call an external A2A 1.0 agent as a declared eve subagent. The filename determines its name. The parent delegates through the normal subagent tools or `ctx.agent()` in a workflow tool.

```ts
// agent/subagents/planner.ts
import { defineA2AAgent } from "eve";

export default defineA2AAgent({
  url: "https://planner.example.com",
  description: "Plans a trip and returns a day-by-day itinerary.",
});
```

`url` accepts an origin or a direct public Agent Card URL. An origin resolves to `/.well-known/agent-card.json`. You can supply an async URL function to read runtime configuration. Compilation never contacts the remote agent.

To expose your own agent to A2A clients, configure an [A2A channel](../channels/a2a).

## Authenticate requests

The `auth` field accepts the same providers as eve connections, including Vercel Connect:

```ts
import { connect } from "@vercel/connect/eve";
import { defineA2AAgent } from "eve";

export default defineA2AAgent({
  url: "https://planner.example.com",
  description: "Plans trips using the user's travel account.",
  auth: connect("planner.example.com/travel"),
});
```

Configure the connector before invoking the subagent. User-scoped providers require an authenticated user principal in the parent session. For a shared machine identity, use an app-scoped provider that can authorize without a browser. See [Vercel Connect](/docs/connections#interactive-oauth-via-vercel-connect).

For a service token, supply a token provider that reads the value at runtime:

```ts
import { defineA2AAgent } from "eve";

export default defineA2AAgent({
  url: () => process.env.PLANNER_URL!,
  description: "Plans trips for the team.",
  auth: {
    getToken: async () => ({ token: process.env.PLANNER_TOKEN! }),
  },
});
```

Use `headers` for a service that requires an API key in another header. Header callbacks receive the current tool context. Tokens and resolved headers are obtained inside each request step, rather than stored in durable workflow state. A rejected bearer token enters eve's existing reauthorization flow.

## Discovery and trust

The Agent Card must be public. eve fetches it without credentials, selects the first advertised A2A 1.0 JSON-RPC interface, and sends authenticated requests to that interface. Credentials are never sent to card discovery, and redirects are rejected.

By default, the interface must share the card's origin. If discovery and invocation use separate hosts, approve the exact invocation origin:

```ts
import { defineA2AAgent } from "eve";

export default defineA2AAgent({
  url: "https://directory.example.com/planner-card.json",
  allowedInterfaceOrigins: ["https://planner.example.com"],
  description: "Plans trips through the approved planner service.",
});
```

Only HTTPS destinations on public networks are accepted. `eve dev` also allows explicit loopback URLs for local testing. eve validates DNS results at connection time. Cards requiring unsupported extensions are rejected. If a card changes its selected endpoint, security declarations, or required extensions during a task, start a new subagent rather than continuing with changed credentials or routing.

## Task lifecycle

An A2A subagent runs as a durable background task. eve sends `SendMessage` with `returnImmediately`, then polls `GetTask`. Polling survives workflow suspension and gradually increases from 500 ms to five seconds. Parent cancellation attempts `CancelTask` on the remote task.

When the remote task needs input, the subagent returns `{ status: "input_required", message }`. Continue the same agent handle with an answer; eve sends it with the existing remote task and context IDs. A remote authorization request returns `{ status: "authorization_required", message }`. Complete the remote service's authorization, then continue the handle to resume polling.

After completion, later calls on the same handle send the remote `contextId` without the completed `taskId`. The remote service decides whether it supports another task in that context. An eve A2A channel currently requires a new handle for new work after completion.

For text output, eve joins artifact text parts. Set `outputSchema` when you expect a structured result: the remote response must contain exactly one data part, and eve validates it against the requested schema. File artifacts are not downloaded. Token usage from the remote service is not available to eve.

Failed sends are not automatically retried because a connection failure can happen after the remote service accepts work. This avoids starting a second task accidentally. Card errors, unsupported bindings, invalid results, and failed remote tasks terminate the subagent invocation.

You can also return `defineA2AAgent(...)` from a `defineDynamic` subagent resolver. Auth and header callbacks remain local to the deployment; durable selections retain their resolver identity rather than resolved credentials.
