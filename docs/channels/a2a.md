---
title: "A2A Channel"
description: "Expose an eve agent to A2A clients with durable tasks, polling, cancellation, and streaming."
---

Use `a2aChannel` to let A2A clients delegate work to your eve agent. The channel supports A2A 1.0 over JSON-RPC, including durable tasks and Server-Sent Events (SSE).

To call another A2A agent from eve, configure an [A2A subagent](../subagents/a2a).

## Publish an agent

Create `agent/channels/a2a.ts`. Choose an authentication policy explicitly. This example allows public access:

```ts
import { a2aChannel } from "eve/channels/a2a";
import { none } from "eve/channels/auth";

export default a2aChannel({ auth: none() });
```

The channel publishes two routes:

| Route                              | Purpose                             |
| ---------------------------------- | ----------------------------------- |
| `GET /.well-known/agent-card.json` | Public Agent Card for discovery     |
| `POST /eve/v1/a2a`                 | JSON-RPC operations and SSE streams |

Set `route` to change the POST path. The Agent Card advertises that path automatically. Production requests require HTTPS; HTTP is accepted on loopback hosts for local use. Browser requests with an `Origin` header must match the agent's origin.

The card derives its name and description from the compiled agent metadata. Its version defaults to `1.0.0`; set `card.version` to your application's version. The default card exposes one generic skill. Internal instructions, tools, and filesystem skills are not published. Set `card.skills` to describe the capabilities you want clients to discover.

## Require authentication

Use the same [route authentication policies](../guides/auth-and-route-protection) as other eve channels. Declare the corresponding security scheme in the public card:

```ts
import { a2aChannel } from "eve/channels/a2a";
import { oidc } from "eve/channels/auth";

const issuer = "https://auth.example.com";

export default a2aChannel({
  auth: oidc({ issuer, audiences: ["https://agent.example.com"] }),
  card: {
    securitySchemes: {
      identity: {
        openIdConnectSecurityScheme: {
          openIdConnectUrl: `${issuer}/.well-known/openid-configuration`,
        },
      },
    },
    securityRequirements: [{ schemes: { identity: { list: [] } } }],
  },
});
```

Every operation authenticates the caller and checks ownership of the requested task. Missing or invalid credentials return HTTP `401`; denied access returns `403`. An inaccessible task is reported as not found. Authenticated channels must provide both `card.securitySchemes` and `card.securityRequirements`; the declarations describe your policy, while the policy performs verification.

The Agent Card remains public. Put deployment protection in front of task operations only, or explicitly allow public access to the card route. Card discovery does not receive invocation credentials.

With `none()`, possession of a task ID grants access to that task. Anonymous `ListTasks` calls return no tasks unless the caller supplies a known `contextId`.

## Send and follow a task

POST a JSON-RPC request with `Content-Type: application/json` and `A2A-Version: 1.0`:

```json
{
  "jsonrpc": "2.0",
  "id": "request-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "message-1",
      "role": "ROLE_USER",
      "parts": [{ "text": "Plan Alice's visit to Paris." }]
    },
    "configuration": { "returnImmediately": true }
  }
}
```

The result contains `{ "task": { ... } }`. Save its `id`, then call `GetTask` with `{ "id": "<task-id>" }`. Omit `returnImmediately` to wait until the task completes or needs input or authorization. Disconnecting a request does not cancel the task; use `CancelTask` explicitly.

| Method                 | Behavior                                     |
| ---------------------- | -------------------------------------------- |
| `SendMessage`          | Start work or answer a pending input request |
| `GetTask`              | Read the current durable task snapshot       |
| `CancelTask`           | Cancel active work                           |
| `ListTasks`            | List tasks owned by the authenticated caller |
| `SendStreamingMessage` | Start work and stream task updates           |
| `SubscribeToTask`      | Reconnect to an active task's updates        |

SSE begins with a task snapshot, then sends artifact and status updates as durable state changes. The stream closes when the task completes or needs input or authorization. Streaming exposes task progress and completed artifacts; it does not stream model tokens. Reconnect with `SubscribeToTask`, or use `GetTask` after completion.

## Answer input requests

When the task reaches `TASK_STATE_INPUT_REQUIRED`, read `status.message`. It includes the question and a data part with `inputRequests`. For a single pending question, send another user message with the same `taskId` and the answer as text. For an option question, send the option ID or label.

For multiple pending requests, send a data part:

```json
{
  "data": {
    "inputResponses": [
      { "requestId": "<request-id>", "text": "Paris" },
      { "requestId": "<another-request-id>", "optionId": "yes" }
    ]
  }
}
```

In this version, each eve task has one context and `contextId` equals `taskId`. Continuations answer pending input only. To start new work after completion, omit both IDs.

`TASK_STATE_AUTH_REQUIRED` means an agent dependency needs authorization. Complete that authorization through your application's existing eve sign-in flow, then poll or subscribe again. The public task includes a description; it does not expose eve's authorization callback capabilities or provider state.

## Results and limits

Text results appear in artifact text parts. Structured results appear in a data part. Incoming text, data, and URL parts are supported; URL parts are passed to the agent as text rather than fetched by the channel. Raw file parts are rejected.

`ListTasks` supports `contextId`, `status`, `statusTimestampAfter`, `pageSize`, `pageToken`, `historyLength`, and `includeArtifacts`. The default page size is 50, with a maximum of 100. Artifacts are omitted unless requested. History is bounded to the most recent 64 messages available in eve's retained event window. General listing inspects at most 1,000 retained workflow records, checking ownership before reading task content. If the application has more records, supply `contextId` for direct lookup.

Request bodies are limited to 1 MiB. The channel supports only A2A 1.0 JSON-RPC. A2A 0.3, HTTP+JSON, gRPC, push notifications, signed cards, authenticated extended cards, and tenant routing are outside this release.
