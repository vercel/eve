---
issue: https://github.com/vercel/eve/discussions/186
last_updated: "2026-06-27"
status: proposed
---

# Persistent outbound channels for long-running hosts

## Summary

eve channels are request-first today. A channel declares HTTP or WebSocket routes, a provider calls
those routes, and the route handler starts or resumes a durable session through `send`. That works
well for hosted webhooks, but it leaves self-hosted agents with no first-class way to connect out to
a provider and receive events without exposing a public endpoint.

Add named `listeners` to `defineChannel`. A listener is a process-owned ingress loop for long-running
hosts. eve starts it when `eve dev` or `eve start` owns the server process, passes it the same session
helpers that route handlers use, supervises it, and stops it on shutdown or dev reload.

The important boundary is durability: listener code is process lifecycle code and is not durable.
Sessions started through `send` remain durable and continue to use normal channel adapter state,
continuation tokens, events, metadata, tools, hooks, and workflow execution.

## Problem

Some providers support or require outbound event delivery:

- Discord receives regular messages and reactions through the Discord Gateway WebSocket.
- Slack supports Socket Mode for apps that cannot receive public Events API webhooks.
- Telegram supports `getUpdates` polling as an alternative to webhooks.

These modes are useful for local development, Docker deployments, home servers, private networks,
and teams that do not want to expose an inbound route to the internet. Today an eve author can build
an external bridge with the TypeScript client and a provider SDK, but that splits one channel across
two programs. The bridge must duplicate auth mapping, continuation-token logic, HITL handling,
delivery behavior, and operational lifecycle.

eve should let a channel own both request-driven ingress and process-driven ingress in the same
authoring file.

## Authoring API

`defineChannel` should accept optional `routes` and optional named `listeners`:

```ts
import { defineChannel } from "eve/channels";

export default defineChannel({
  listeners: {
    gateway: async ({ signal, send }) => {
      for await (const event of provider.events({ signal })) {
        await send(event.text, {
          auth: event.auth,
          continuationToken: event.threadKey,
          state: {
            channelId: event.channelId,
            conversationId: event.conversationId,
          },
        });
      }
    },
  },

  events: {
    "message.completed"(event, channel) {
      // Deliver the agent reply back to the provider.
    },
  },
});
```

`routes` defaults to `[]`, so listener-only channels are valid. The channel file path still supplies
the channel name, and each listener key supplies a stable local listener id. For example,
`agent/channels/discord.ts` with `listeners.gateway` has the runtime listener id
`channel:discord:gateway`.

The listener argument is intentionally smaller than `RouteHandlerArgs`:

```ts
export interface ChannelListenerArgs<TState = undefined> {
  readonly signal: AbortSignal;
  readonly send: SendFn<TState>;
  readonly receive: CrossChannelReceiveFn;
  readonly getSession: GetSessionFn;
}
```

- `signal` is aborted when eve stops the listener because the server is closing, the channel changed
  during `eve dev`, or listeners are disabled.
- `send` starts or resumes a session on the same channel. It owns the same continuation-token
  namespacing, deliver-then-run fallback, initial adapter state, auth, title, and run mode as route
  handlers.
- `receive` hands work to another channel's `receive` hook, matching route handlers and schedules.
- `getSession` looks up a session by eve session id for advanced stream or status bridging.

Listeners do not receive `Request`, `params`, `requestIp`, or `waitUntil`. Those are request-scoped
concepts. A listener is already long-lived, so its function body is the background task.

The object form leaves room for lifecycle controls without changing the basic API:

```ts
listeners: {
  gateway: {
    restart: "always",
    startup: "best-effort",
    run: async ({ signal, send }) => {},
  },
}
```

For the first implementation, support both the shorthand function form and the object form. Default
options:

- `enabled: true`
- `restart: "always"`
- `startup: "best-effort"`
- `backoff: { minMs: 1000, maxMs: 30000 }`
- `shutdownTimeoutMs: 5000`

`enabled` may be a boolean or a zero-argument function evaluated at listener startup, so channel
wrappers can gate a listener on environment variables without registering a route.

## Lifecycle

eve manages listeners at the host process boundary:

```text
process startup
`-- resolve compiled root agent
    `-- resolve channels
        `-- ChannelListenerManager.start()
            |-- create runtime and channel helpers
            |-- create AbortController per listener
            `-- invoke listener({ signal, send, receive, getSession })

provider event
`-- listener parses event
    `-- send(message, { auth, continuationToken, state })
        |-- runtime.deliver(existing session)
        `-- or runtime.run(new durable session)

process shutdown or dev reload
`-- ChannelListenerManager.stop()
    |-- abort each listener signal
    |-- wait for listener promises up to shutdownTimeoutMs
    `-- log listeners that fail to settle
```

The manager treats an unrequested return as a stopped listener. If the listener returns or throws
before `signal` aborts, the manager logs the outcome and applies restart policy. `restart: "always"`
restarts on return and throw; `"on-error"` restarts only on throw; `"never"` does not restart.

Backoff is fixed exponential: `1s`, `2s`, `5s`, `10s`, then capped at `30s` by default. The backoff
resets after a listener stays up long enough to receive an event or after a small stable window, so a
temporary provider outage does not permanently slow the listener.

Startup defaults to best effort. A bad token should not make unrelated HTTP routes fail to bind
unless the author opts into `startup: "required"`. Required startup means the first listener failure
during boot fails the owning host startup.

## Runtime semantics

Listeners are channel ingress, not durable workflow steps.

Process-local listener state is lost on restart:

```ts
listeners: {
  polling: async ({ signal }) => {
    let offset = 0; // process-local
  },
}
```

Session state supplied to `send` is durable:

```ts
await send(message, {
  auth,
  continuationToken,
  state: {
    chatId,
    conversationId,
  },
});
```

The listener must persist provider cursor state through provider-owned mechanisms or an external
store when at-least-once behavior matters. For example, Telegram `getUpdates` can acknowledge
updates by advancing the offset after dispatch. Discord Gateway resume state should follow Discord's
session and sequence rules. eve should not invent a generic cursor store in v1 because cursor
semantics are provider-specific and often already owned by the platform.

`send` retains the current channel contract:

- The caller passes a channel-local raw continuation token.
- eve prefixes the token with the channel name before calling the runtime.
- eve first tries `runtime.deliver` to resume a parked or waiting session.
- If no session is active for that continuation token, eve starts a new session with the channel
  adapter and provided initial state.
- Adapter `events` still deliver outgoing messages, HITL prompts, auth notifications, and failures.
- `metadata(state)` still projects channel-owned observability fields.

Listener restarts must not mutate durable sessions by themselves. Only explicit calls to `send`,
`receive`, or session APIs can affect runtime state.

## Host behavior

`eve dev` starts listeners in the dev-server owner process only. If a second CLI attaches to an
already-running dev server, it must not start a second listener set. The authored-source watcher
reconciles listeners after channel or environment changes:

- unchanged listeners keep running;
- removed or disabled listeners are aborted;
- changed listeners are aborted and restarted from the new compiled artifacts;
- route-only changes continue to use the existing channel route sync path.

`eve start` starts listeners inside the built Node server process after the server is ready to bind
HTTP routes and runtime artifacts are installed. Closing the production server handle aborts
listeners before the process exits.

Vercel and other serverless outputs should compile listener declarations but not run them. Build and
info surfaces should expose a clear diagnostic:

> Persistent channel listeners are defined but will not run on this serverless output. Run this app
> with `eve start` or another long-running host to enable them.

Add `EVE_CHANNEL_LISTENERS=0` as a host-level escape hatch for self-hosted deployments that want only
HTTP routes.

Multi-replica listener ownership is out of scope for v1. If a deployment runs three `eve start`
processes, all three will start listeners unless the deployment disables them or the provider allows
only one active connection. The docs must call this out. A future version can add leader election or
external coordination when eve has a durable host-level coordination primitive.

## Built-in channels

Provider wrappers should expose provider terms while compiling down to generic listeners.

Discord:

```ts
discordChannel({ transport: "gateway" });
discordChannel({ transport: "webhook" }); // default
discordChannel({ transport: "both" });
```

`gateway` is Discord's name for its persistent WebSocket event connection. It should reuse the
existing Discord state, auth mapping, continuation tokens, default delivery handlers, HITL handling,
and proactive `receive` target. Webhook interactions remain the default because they fit hosted
serverless deployments and Discord slash-command ACK rules.

Telegram:

```ts
telegramChannel({ transport: "polling" });
telegramChannel({ transport: "webhook" }); // default
telegramChannel({ transport: "both" });
```

Polling uses `getUpdates` from a listener. The channel should advance provider offsets only after it
has accepted the update for dispatch. The first version can keep offset in process memory and
document at-least-once behavior across restarts; a later version can add provider-specific cursor
configuration if needed.

Slack:

```ts
slackChannel({ transport: "socket" });
slackChannel({ transport: "webhook" }); // default
slackChannel({ transport: "both" });
```

Socket Mode is Slack's provider term. The generic listener lifecycle should land before Slack Socket
Mode unless the protocol implementation fits cleanly in the same change. Slack's existing webhook
and Connect behavior should remain unchanged by default.

Transport-specific provider options belong on built-in wrapper configs, not on generic listener
options. For example Discord intents, Telegram polling timeout, and Slack app-level tokens should be
owned by `discordChannel`, `telegramChannel`, and `slackChannel` respectively.

## Implementation outline

Refactor the compiled channel model from route-first to channel-first. Today each route becomes its
own compiled channel entry, which means a channel with zero routes disappears. The new shape should
preserve one authored channel entry with nested routes and listener metadata.

Runtime resolution should load each channel module once per channel, set the path-derived channel
kind once, and expose:

- `name`
- `definition`
- `adapter`
- `receive`
- `routes`
- `listeners`

Route registration can still flatten `routes` into Nitro handlers. Cross-channel `receive` should
target resolved channels, not route entries. Listener management should use the same resolved channel
set as schedules and routes so all ingress paths agree on channel identity.

Add a package-owned `ChannelListenerManager` that accepts compiled artifacts source and resolved root
channels. The manager owns start, stop, restart, logging, backoff, and disabled-host behavior. It
should create a `createWorkflowRuntime(...)` runtime in the same way route dispatch and schedules do,
then build helper closures with `createSendFn`, `createCrossChannelReceiveFn`, and
`createGetSessionFn`.

## Risks and constraints

- **Duplicate delivery:** Multiple long-running processes can start the same listener. v1 documents
  single-owner deployment expectations and provides `EVE_CHANNEL_LISTENERS=0`.
- **Provider cursors:** Cursor persistence is provider-specific. The generic API should not pretend a
  single offset store works for Discord, Slack, and Telegram.
- **Process-local state:** Listener local variables are not durable. Durable state begins only when
  `send` starts or resumes a session.
- **Serverless confusion:** Serverless outputs must make disabled listener behavior obvious in build
  and info surfaces.
- **Dependency budget:** Do not add runtime dependencies for v1. eve should keep provider protocol
  code behind eve-owned wrappers and prefer Node platform APIs or vendored/generated code where
  practical.
- **Shutdown behavior:** Abort is cooperative. eve can abort signals and log stuck listeners, but
  third-party SDKs may not exit promptly.

## Delivery and verification

The implementation should include:

- public `defineChannel` listener types and exactness tests;
- compiler tests for route-plus-listener and listener-only channels;
- manifest version and schema tests;
- runtime resolution tests proving listener-only channels remain registered for instrumentation and
  cross-channel `receive`;
- `ChannelListenerManager` tests for start, abort, restart policy, disabled listeners, and helper
  wiring;
- dev host tests proving the owning dev server starts listeners once and reconciles them on channel
  or environment changes;
- production host tests proving `eve start` starts and stops listeners with the built server;
- serverless/Vercel tests proving listeners compile but do not run and diagnostics are visible;
- fake-provider built-in tests for Discord Gateway and Telegram polling;
- docs for custom channels and each built-in transport after the API lands.

This research-only change does not need a changeset. The implementation PR will touch the published
`eve` package and should include a patch changeset unless it intentionally breaks public API shape.
