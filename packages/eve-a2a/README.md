# @eve/a2a prototype

This prototype serves and consumes an A2A 1.0 subset entirely through authored tools, a channel, and application-owned helpers, using the existing eve extension contract. The package is private and is not released to npm.

## Mount the extension

Build from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @eve/a2a... build
```

Declare `"@eve/a2a": "workspace:*"` in the consuming agent's dependencies and create `agent/extensions/a2a.ts`:

```ts
import a2a from "@eve/a2a";

export default a2a({
  server: {
    origin: "https://your-agent.example",
    signingSecretEnv: "A2A_SIGNING_SECRET",
    users: [{ username: "caller", passwordEnv: "A2A_SERVER_PASSWORD" }],
  },
  remote: {
    origin: "https://remote-agent.example",
    username: "caller",
    passwordEnv: "A2A_REMOTE_PASSWORD",
  },
});
```

Set the named environment variables in the consuming application. The extension reads secrets at runtime; it has no default credentials or signing key. Keep the signing key stable across restarts. Both sides currently use HTTP Basic authentication. Use HTTPS outside local development. Discovery accepts only a same-origin JSON-RPC endpoint from the configured remote's Agent Card.

The mount contributes `a2a__send`, `a2a__get`, and `a2a__cancel`. A different mount filename changes that prefix. The channel serves `/a2a` and `/.well-known/agent-card.json`; these paths are fixed, so mount one copy per agent. This prototype configures both serving and consuming together.

## Durable watcher boundary

The extension packages the channel and three ordinary tools. The consumer owns the [durable watcher](../../apps/fixtures/a2a-public-api/agent/tools/a2a_delegate.ts) and its two [step wrappers](../../apps/fixtures/a2a-public-api/agent/lib/remote-steps.ts). These wrappers call the extension's `@eve/a2a/client` export. The workflow body never imports the extension's compiled JavaScript directly; that output includes Node.js module setup, which belongs inside a step.

`eve extension build` currently rejects `"use workflow"` and `"use step"` in extension source. The [application-module check](../eve/src/internal/workflow-bundle/workflow-builders.ts) also excludes dependencies outside the consuming application. Packaging the whole watcher as an extension contribution requires framework support beyond the existing APIs. This draft preserves the working application workflow and makes that limitation explicit; it adds no framework APIs or compiler exceptions.

## Run the demonstration

The [consumer fixture](../../apps/fixtures/a2a-public-api/README.md) mounts the built extension. Its deterministic `mockModel` needs no model credentials, while requests execute the real compiler, session runtime, tools, workflows, and HTTP transport.

```sh
pnpm --filter @eve/a2a test:unit
pnpm --filter fixture-a2a-public-api verify
```

The verification script copies only the extension distribution into an isolated consumer, builds it, runs HTTP and namespaced tool scenarios, restarts the server during a durable wait, and checks that the existing task and watcher resume. It uses an available loopback port and stops its server afterward. Detailed output goes to the fixture's `verify.log`.

## Implementation boundary

| File                                                                              | Responsibility                                                   | Existing API                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| [a2a-channel.ts](extension/lib/a2a-channel.ts)                                    | Agent Card, JSON-RPC, input replies, cancellation, SSE           | `defineChannel`, `GET`, `POST`, `routeAuth`, public session handles |
| [projection.ts](extension/lib/projection.ts)                                      | Reconstruct A2A task state from persisted session events         | `Session.getEventStream`, `getStreamTailIndex`                      |
| [identity.ts](extension/lib/identity.ts)                                          | Bind the task ID to its session and authenticated owner          | Node HMAC; application code                                         |
| [send.ts](extension/tools/send.ts)                                                | Start a remote task or answer its pending question               | `defineTool`                                                        |
| [get.ts](extension/tools/get.ts), [cancel.ts](extension/tools/cancel.ts)          | Inspect or cancel remote work                                    | `defineTool`                                                        |
| [a2a_delegate.ts](../../apps/fixtures/a2a-public-api/agent/tools/a2a_delegate.ts) | Submit or attach to remote work, poll durably, notify the parent | `defineWorkflowTool`, `sleep`, `yield task.postMessage`             |
| [client.ts](extension/lib/client.ts)                                              | Discovery and authenticated A2A requests                         | `fetch`; the consumer adds `"use step"` wrappers                    |

The remote **A2A task ID** and the local **eve watcher task ID** identify different work. The workflow keeps the remote ID in a local variable across durable waits. An independent `send` tool call answers that remote task directly; the existing watcher observes the result on its next poll. No parent-to-workflow inbox is needed.

On the server, one A2A task owns one eve conversation session. Conversation mode makes input requests available through the existing public channel API. `contextId` equals the signed task ID in this prototype. Completed tasks stay immutable in the projection, even if another surface subsequently adds events to the underlying session. The signature binds the session ID and owner; it does not encrypt them. State reads fold the persisted stream, so there is no process-local task registry to lose on restart.

## Demonstrated behavior

- Agent Card discovery at `/.well-known/agent-card.json`.
- A2A 1.0 JSON-RPC `SendMessage`, `GetTask`, `CancelTask`, `SendStreamingMessage`, and `SubscribeToTask`.
- Blocking and immediate sends; one free-text question and a reply on the same task.
- Authenticated owner isolation, terminal-state rejection, final text artifacts, and SSE status/artifact updates.
- Real model-to-tool dispatch through a deterministic model, background receipts, parent notifications, and independent reply tools.
- An explicit remote cancellation operation. Canceling a local watcher stops monitoring; it does not cancel the remote task.

## Limits exposed by the prototype

- This is a text-only protocol subset, not a general A2A SDK or a conformance claim. It excludes context continuation across tasks, task listing, push notifications, extended cards, file parts, arbitrary structured input batches, and remote authorization flows. The Agent Card still has fixed prototype metadata. The server emits tasks; the client currently expects a task response rather than A2A's direct-message alternative.
- The server's task status describes completion of the served invocation. Agents that launch detached background work and acknowledge immediately need an application policy for deciding when their A2A task is complete.
- Reads fold the full session event stream. This favors a small implementation over an indexed task store; cost grows with session history. Sessions remain in eve's storage under its retention policy.
- A network failure after accepting `SendMessage` can leave an ambiguous result. This prototype does not deduplicate submissions by `messageId`; workflow step retry is not a guarantee of exactly-once remote submission.
- Blocking HTTP requests and SSE connections remain subject to host/request lifetimes. A disconnect does not cancel the task; reconnect or poll for its state.
- The application watcher is a static workflow tool. There is no dynamic `defineA2AAgent` factory or new subagent kind in this implementation.

Two behaviors observed during the original `eve@0.52.2` spike are handled by the extension:

1. A literal `.json` route gives eve's virtual JavaScript handler a `.json` suffix, triggering the bundler's JSON parser. The channel declares `/.well-known/:document` and accepts only `agent-card.json`, preserving the discovery URL.
2. A parked workflow can emit `turn.completed` while its tool is pending, and answering it can settle the tool without `input.resolved`. The projection tracks pending tool calls and clears their questions on `action.result`. A turn boundary alone is insufficient evidence of task completion.

The local scenarios and projection tests cover these boundaries. They do not establish interoperability with another A2A implementation, real-model tool selection, or hosted deployment behavior.

## References

- [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/): wire messages, task states, JSON-RPC envelopes, and SSE events.
- [A2A 1.0 protocol definitions](https://github.com/a2aproject/A2A/blob/v1.0.0/specification/a2a.proto): message fields and Agent Card security requirements.
- [eve extensions](../../docs/extensions.md), [workflow tools](../../docs/tools/workflows.mdx), and [custom channels](../../docs/channels/custom.mdx): existing authoring APIs.
