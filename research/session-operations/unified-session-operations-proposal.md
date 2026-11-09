---
issue: https://github.com/vercel/eve/issues/1580
status: proposed
last_updated: "2026-08-04"
---

# Unified session operations

## Decision

eve exposes two identities with the same operation names:

- `from(address)` binds a channel-local address and returns operations targeting
  its current owner.
- `Session` is a fixed handle for one durable `sessionId`.

`ChannelAddress` is not a public authoring API. eve may bind an address
internally to implement `from` and platform conveniences such as
Slack's thread-bound `ctx.send()` and `ctx.cancel()` methods.

```text
channel-local address ──> current owner ─┐
                                        ├─> one durable command inbox
sessionId ───────────────────────────────┘
```

The identity determines the behavior:

- `from(address).send(message, options)` resumes the current owner, or creates
  and claims the address when it is unowned.
- The other `from(address).*` operations target the current owner and never
  create.
- `resolveSession(address)` is the only explicit conversion from a dynamic
  address to a fixed `Session`. It is top-level beside `from`, not a method on
  the bound source.
- Every `session.*` method targets exactly `session.id`. It never creates or
  follows a replacement.

This is intentionally a breaking API migration with no compatibility aliases.

## Public authoring contract

Custom channel routes and authored `receive` functions get two top-level
identity selectors:

```ts
interface ChannelReceiveContext<TState = undefined> {
  from(address: string): ChannelSource<TState>;
  resolveSession(address: string): Promise<Session | undefined>;
}

interface ChannelSource<TState = undefined> {
  send(message: string | UserContent, options: ChannelSendOptions<TState>): Promise<Session>;
  respond(
    inputResponses: readonly InputResponse[],
    options: ChannelRespondOptions,
  ): Promise<Session>;
  cancel(options?: { turnId?: string }): Promise<CancelTurnResult>;
  compact(): Promise<CompactSessionResult>;
  clear(): Promise<ClearSessionResult>;
  reset(options?: { reason?: string }): Promise<ResetSessionResult>;
}

interface BaseChannelSendOptions {
  auth: SessionAuthContext | null;
  context?: readonly string[];
  outputSchema?: JsonObject;
  callback?: SessionCallback;
  initiatorAuth?: SessionAuthContext | null;
  mode?: RunMode;
  title?: string;
}

type ChannelSendOptions<TState = undefined> = [TState] extends [undefined]
  ? BaseChannelSendOptions
  : BaseChannelSendOptions & { state: TState };

interface ChannelRespondOptions {
  auth: SessionAuthContext | null;
  context?: readonly string[];
  outputSchema?: JsonObject;
}
```

Fixed-ID operations use a `Session`:

```ts
interface Session {
  readonly id: string;

  send(
    message: string | UserContent,
    options: SessionSendOptions,
  ): Promise<SessionSendCommandResult>;
  respond(
    inputResponses: readonly InputResponse[],
    options: SessionRespondOptions,
  ): Promise<SessionSendCommandResult>;
  cancel(options?: { turnId?: string }): Promise<CancelTurnResult>;
  compact(): Promise<CompactSessionResult>;
  clear(): Promise<ClearSessionResult>;
  reset(options?: { reason?: string }): Promise<ResetSessionResult>;

  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<MessageStreamEvent>>;
  getStreamTailIndex(): Promise<number>;
}

interface SessionSendOptions {
  auth: SessionAuthContext | null;
  caller?: TurnCaller;
  context?: readonly string[];
  outputSchema?: JsonObject;
}

type SessionRespondOptions = SessionSendOptions;
```

`attachSession(sessionId)` constructs this handle without I/O. The first
operation reports whether the ID is active.

## Semantics

| Call                       | Identity used        | Can create        | Missing target       |
| -------------------------- | -------------------- | ----------------- | -------------------- |
| `from(address).send(...)`  | continuation address | only when unowned | creates and claims   |
| `from(address).respond(…)` | continuation address | no                | throws               |
| `from(address).cancel()`   | continuation address | no                | `no_active_turn`     |
| `from(address).compact()`  | continuation address | no                | `no_active_session`  |
| `from(address).clear()`    | continuation address | no                | `no_active_session`  |
| `from(address).reset()`    | continuation address | no                | `no_active_session`  |
| `resolveSession(address)`  | continuation address | no                | `undefined`          |
| `session.send(…)`          | session ID           | no                | `session_not_active` |
| `session.respond(…)`       | session ID           | no                | `session_not_active` |
| `session.cancel()`         | session ID           | no                | `no_active_turn`     |
| `session.compact()`        | session ID           | no                | `no_active_session`  |
| `session.clear()`          | session ID           | no                | `no_active_session`  |
| `session.reset()`          | session ID           | no                | `no_active_session`  |
| `session.getEventStream()` | session ID           | no                | not found            |

Address-only HITL `inputResponses` cannot create a session because only the
session that issued the request can consume them.

`cancel`, `compact`, and `clear` are durably queued asynchronous controls.
`reset` retires the target and releases its aliases before returning. Awaited
commands sent through the same address preserve commit order.

A live session returns `accepted` for `cancel` even when it is already parked;
the driver consumes that late or duplicate command as a no-op. The stream is
authoritative for whether a turn emitted `turn.cancelled`. `no_active_turn`
means the session or channel address is unknown or terminal.

## Authoring shapes by surface

### Custom channel route

```ts title="agent/channels/support.ts"
import { defineChannel, GET, POST } from "eve/channels";

export default defineChannel({
  routes: [
    POST("/threads/:threadId/messages", async (request, { from, params }) => {
      const body = await request.json();
      const session = await from(params.threadId).send(body.message, {
        auth: null,
      });

      return Response.json({ sessionId: session.id });
    }),

    POST("/threads/:threadId/cancel", async (_request, { from, params }) =>
      Response.json(await from(params.threadId).cancel()),
    ),

    POST("/threads/:threadId/compact", async (_request, { from, params }) =>
      Response.json(await from(params.threadId).compact()),
    ),

    POST("/threads/:threadId/clear", async (_request, { from, params }) =>
      Response.json(await from(params.threadId).clear()),
    ),

    POST("/threads/:threadId/reset", async (_request, { from, params }) =>
      Response.json(await from(params.threadId).reset({ reason: "Start over" })),
    ),

    GET("/threads/:threadId/owner", async (_request, { params, resolveSession }) => {
      const session = await resolveSession(params.threadId);
      return Response.json({ sessionId: session?.id ?? null });
    }),

    POST("/admin/session/:sessionId", async (request, { attachSession, params }) => {
      const session = attachSession(params.sessionId);
      return Response.json(await session.send(await request.text(), { auth: null }));
    }),
  ],
});
```

`from` makes dynamic routing visible without exposing the internal
`ChannelAddress` representation. `resolveSession` stays top-level because it
snapshots an address rather than operating through the dynamic source.

### Authored receive and cross-channel handoff

A channel's `receive` implementation owns its continuation-address format and
initial state:

```ts
export default defineChannel<State, Context, Target>({
  async receive(input, { from }) {
    const address = addressFromTarget(input.target);

    return await from(address).send(input.message, {
      auth: input.auth,
      state: initialState(input.target),
    });
  },
});
```

A schedule selects the target with `to(channel, target)` and receives a fixed
session from `send`:

```ts
export default defineSchedule({
  cron: "0 9 * * *",
  async run({ to, appAuth }) {
    const session = await to(slack, { channelId, threadTs }).send("Investigate this incident", {
      auth: appAuth,
    });

    await session.send("Additional detail", { auth: appAuth });
    await session.cancel();
    await session.compact();
    await session.clear();
    await session.reset();
  },
});
```

A channel route uses the same `to(channel, target).send(message, options)`
handoff:

```ts
const session = await args
  .to(slack, { channelId, threadTs })
  .send("Investigate this incident", { auth });
```

Neither caller knows the target channel's address format. Later operations on
the returned `Session` cannot follow that address to a replacement.

### Slack

Message and interaction handlers get flat operations already bound to their
Slack thread. `ctx.send()` derives auth from the inbound Slack user unless the
input supplies `auth` explicitly:

```ts
async onAppMention(ctx) {
  await ctx.send("Run a separate turn");
  await ctx.respond(inputResponses);
  await ctx.cancel({ turnId });
  await ctx.compact();
  await ctx.clear();
  await ctx.reset({ reason: "Start over" });

  const fixed = await ctx.resolveSession();
  return { auth: null };
}
```

The calls above show the available operations; a handler normally chooses one.

Generic events put the explicit Slack target in each operation's input:

```ts
async onEvent(ctx) {
  const target = { channelId, threadTs };

  await ctx.clear({ target });
  await ctx.cancel({ target, turnId });
  await ctx.compact({ target });
  await ctx.reset({ reason: "Start over", target });
  const fixed = await ctx.resolveSession({ target });

  const session = await ctx.send("hello", { auth: null, target });
  await ctx.respond(inputResponses, { auth: null, target });

  await session.send("follow-up", { auth: null });
}
```

Slack does not expose a conversation wrapper or reintroduce a generic public
`ChannelAddress` type.

### Chat SDK bridge

The Chat SDK bridge binds delivery to the webhook that is currently running.
It retains its existing two-argument `send(input, options)` API. The first
argument is a string, `UserContent`, or `SendPayload`; the second carries the
originating thread and turn options:

```ts
export const { bot, channel, send } = chatSdkChannel({ adapters, state });

bot.onNewMention(async (thread, message) => {
  await send(message.text, {
    thread,
    title: "Support request",
    turnPolicy: "experimental-steer",
  });
});
```

HITL responses use a `SendPayload` as the first argument:

```ts
await send({ inputResponses: [{ requestId, optionId: "approve" }] }, { thread });
```

Methods that post eve output back through a platform SDK, such as
`thread.post(...)`, remain platform output APIs rather than session delivery
operations.

### eve framework HTTP channel

The default HTTP surface is singular and entirely session-ID addressed:

```http
GET  /eve/v1/health
GET  /eve/v1/info

POST /eve/v1/session
{"message":"hello"}

POST /eve/v1/session/wrun_A
{"message":"follow-up"}

POST /eve/v1/session/wrun_A/cancel
{"turnId":"turn_A"}

POST /eve/v1/session/wrun_A/compact
POST /eve/v1/session/wrun_A/clear

POST /eve/v1/session/wrun_A/reset
{"reason":"Start over"}

GET  /eve/v1/session/wrun_A/stream
```

`POST /eve/v1/session` explicitly creates. Every route containing `wrun_A`
dispatches or reads directly by that ID. Follow-up delivery remains the default
operation on `POST /eve/v1/session/:sessionId`; there is no `/messages` suffix.

An unknown or terminal ID on the follow-up route returns
`session_not_active`. Controls never create. HTTP accepts and returns no
continuation token.

### JavaScript HTTP client

```ts
const { session, response } = await client.sessions.create({ message: "hello" });
await response.result();

await (await session.send({ message: "follow-up" })).result();
await session.cancel({ turnId });
await session.compact();
await session.clear();
await session.reset({ reason: "Start over" });

for await (const event of session.stream()) {
  // ...
}
```

Attach to a known ID without I/O:

```ts
const session = client.sessions.attach("wrun_A", { streamIndex: 12 });
```

The serializable cursor contains only fixed identity and stream position:

```ts
interface ClientSessionState {
  readonly sessionId: string;
  readonly streamIndex: number;
}
```

Reset leaves the handle pinned to its retired ID. Creating a replacement is an
explicit `client.sessions.create(...)` call.

### Evals

Eval sends use the same input object as the JavaScript client. The live-turn
helper keeps its concise positional message because it only starts a text turn:

```ts
const completed = await t.send({ message: "Run the check" });
const live = await t.start("Run the long check");

await live.cancel();
await live.result();
```

### TUI

```text
first prompt   → client.sessions.create({ message })
later prompt   → session.send({ message })
/cancel        → session.cancel()
Esc            → session.cancel()
Ctrl+C         → session.cancel(); a repeated Ctrl+C exits
/compact       → session.compact()
/clear, /new   → session.clear()
/reset         → session.reset(); discard the handle
event loop     → session.stream()
```

When no turn is running, the first Ctrl+C arms exit and prints the instruction
to press it again. The TUI stores no continuation token and performs no
resolution.

### Channel lifecycle handlers

Lifecycle handlers are already inside the owning workflow. The `channel`
argument carries platform state and optional continuation routing, not session
identity:

```ts
interface ChannelEventContext<TPlatformContext> extends TPlatformContext {
  readonly continuation?: {
    readonly token: string;
    rekey(address: string): void;
  };
}

const events = {
  "message.completed"(data, channel, ctx) {
    console.log(ctx.session.id);
  },

  "session.failed"(data, channel) {
    console.error(data.sessionId, data.message);
  },
};
```

Normal lifecycle handlers read fixed session identity from `ctx.session.id`.
`session.failed` runs outside session context, so its event data contains
`sessionId` directly.

Rekeying changes the dynamic channel alias while the stable session-ID alias
continues to target the same inbox.

## Runtime boundary

Both public identity forms dispatch one shared command protocol:

```ts
type SessionCommand =
  | {
      kind: "send";
      auth: SessionAuthContext | null;
      caller?: TurnCaller;
      payload: DeliverPayload;
      requestId?: string;
    }
  | { kind: "cancel"; turnId?: string }
  | { kind: "compact" }
  | { kind: "clear" }
  | { kind: "reset"; reason?: string };

interface Runtime {
  createSession(input: RunInput): Promise<{ sessionId: string }>;

  dispatchContinuation(input: {
    continuationToken: string;
    command: SessionCommand;
  }): Promise<SessionCommandResult>;

  dispatchSession(input: {
    sessionId: string;
    command: SessionCommand;
  }): Promise<SessionCommandResult>;

  resolveContinuation(continuationToken: string): Promise<{ sessionId: string } | undefined>;
}
```

A channel-created session owns two aliases for one inbox:

```text
<channel>:<address> ───────────┐
                              ├─> session command inbox
eve:session:<sessionId>:inbox ─┘
```

`dispatchContinuation` resumes the current address owner and returns its
`sessionId` in the same dispatch result. It does not resolve first.
`dispatchSession` computes the stable inbox token from the ID and resumes it
directly. Therefore normal send and control paths perform one command resume,
not resolve-then-deliver.

Only explicit `resolveSession(address)` calls `resolveContinuation`. A future
lightweight owner lookup can optimize that conversion without affecting normal
operation latency.

Internally eve may bind an address to a private continuation handle. The public
`ChannelSource` exposes only the dynamic operations; the underlying
`ChannelAddress` must not be exported or accepted by authored channel APIs.

## Race and lifetime rules

A dynamic operation targets the owner when its command is accepted:

```text
thread-123 → wrun_A
clear(thread-123) clears wrun_A

thread-123 → wrun_B
clear(thread-123) clears wrun_B
```

Resolution freezes one observation:

```ts
const session = await resolveSession("thread-123"); // wrun_A
// thread-123 is later reclaimed by wrun_B
await session?.clear(); // still wrun_A
```

Reset followed by send is ordered:

```ts
await from("thread-123").reset();
const replacement = await from("thread-123").send("start again", { auth, state });
```

The replacement may be created only after the prior owner releases the address.
The old fixed handle remains terminal. Concurrent first sends converge on one
owner; an ownership conflict retries dispatch to the winner.

## Removed public APIs

| Removed                                             | Replacement                                          |
| --------------------------------------------------- | ---------------------------------------------------- |
| HTTP continuation-token fields and control bodies   | `/eve/v1/session/:sessionId/*`                       |
| plural `/eve/v1/sessions` routes                    | singular `/eve/v1/session`                           |
| follow-up `/:sessionId/messages`                    | `POST /:sessionId`                                   |
| `client.session(token)`                             | `client.sessions.create()` or `.attach(id)`          |
| client continuation-token state                     | `{ sessionId, streamIndex }`                         |
| free token helpers                                  | `from(address)` and `resolveSession(address)`        |
| public `ChannelAddress` / `channelAddress(address)` | `from(address)`                                      |
| `resolveActiveSession(address)`                     | `resolveSession(address)`                            |
| `getSession(sessionId)`                             | `attachSession(sessionId)`                           |
| schedule `receive(channel, input)`                  | `to(channel, target).send(message, options)`         |
| Slack `ctx.conversation` and `ctx.receive`          | flat `ctx.send(message, options)` / `ctx.respond(…)` |
| string arguments to client/eval `send()`            | `{ message, ... }` input objects                     |
| split runtime delivery/control methods              | `dispatchContinuation` and `dispatchSession`         |

No deprecated aliases, alternate request parsing, or fallback compatibility
paths remain.

## Verification

The migration must prove:

- Every `from(address)` send/control performs one continuation dispatch and no
  implicit resolution.
- Address send resumes or creates; other address operations never create.
- Every fixed-session and HTTP operation remains pinned to one ID.
- Rekeying preserves fixed-ID delivery while moving only the channel alias.
- Reset releases aliases before replacement creation and an old ID cannot reach
  the replacement.
- Built-in channels, custom routes, authored `receive` functions, schedule
  sends, flat Slack operations, clients, evals, TUI, fixtures, and docs use the
  final shapes.
- Chat SDK bridges retain `send(input, options)` and its existing call sites.
- E2E creates a session, sends a follow-up, cancels, compacts, clears, sends
  successfully afterward, proves a late accepted cancel is a no-op, resets,
  rejects the retired ID, and explicitly creates a replacement.
