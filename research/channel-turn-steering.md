---
issue: https://github.com/vercel/eve/issues/867
status: proposed
last_updated: "2026-07-16"
---

# Channel turn steering

## Summary

Chat-style channels often receive corrective or additional input while an
agent is still working. Waiting for the next turn can let the agent finish an
obsolete answer; hard-cancelling the turn throws away useful work and provides
no replacement input.

Expose one input policy to channel authors:

```ts
turnPolicy: "queue" | "steer";
```

`"queue"` is the existing default: hold input for the next turn. `"steer"`
asks eve to apply the input to the active logical turn at its next safe step
boundary. There is no public `"interrupt"` policy. Whether eve can stop an
obsolete provider or tool operation early is an implementation detail of
steering, not a distinct end-user intent.

Turn cancellation remains separate: it stops active work without replacement
input and emits `turn.cancelled`. Steering keeps the same turn alive and does
not emit a cancellation boundary.

## Public authoring API

### Custom channels

```ts
export type TurnPolicy = "queue" | "steer";

export interface SendOptions<TState> {
  // Existing fields omitted.
  turnPolicy?: TurnPolicy;
}
```

`TurnPolicy` is exported from `eve/channels`. `SendOptions.turnPolicy` is
optional and defaults to `"queue"`.

```ts
export default defineChannel({
  routes: [
    POST("/threads/:threadId/messages", async (request, { params, send }) => {
      const body = await request.json();
      const session = await send(body.text, {
        auth: await authenticate(request),
        continuationToken: params.threadId,
        turnPolicy: "steer",
      });

      return Response.json({ sessionId: session.id });
    }),
  ],
});
```

Use the default queue policy when every response should finish in order:

```ts
await send(message, {
  auth,
  continuationToken: threadId,
});
```

Use cancellation for a stop button with no replacement message:

```ts
await cancel({ continuationToken: threadId, turnId });
```

The continuation-addressed cancellation helper is specified separately in
[Turn cancellation for custom channel routes](./turn-cancellation-channel-ops.md).

### Other channel surfaces

- `ChatSdkSendOptions` exposes the same optional `turnPolicy` and passes it
  unchanged through `bridge.send()`.
- Low-level `Agent.deliver()` and runtime `DeliverInput` expose the same policy
  so authored filesystem routes do not need to recreate `send()`.
- Built-in channels continue to use `"queue"` unless their documented inbound
  behavior explicitly opts into steering. Adding the API must not silently
  change Slack, Teams, Telegram, Twilio, Discord, GitHub, or Linear behavior.
- `send()` continues to return `Session`. A successful return means the input
  was durably admitted, not that a particular steering step has already run.
  The event stream is the observable record of whether it joined the active or
  next turn.

No new public steering event or result union is required.

## Observable semantics

### State matrix

| Session state                                | `queue`                           | `steer`                                                                    |
| -------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| No session owns the continuation token       | Start a new turn.                 | Start a new turn; there is nothing to steer yet.                           |
| Session is parked and waiting for input      | Start the next turn.              | Start the next turn; it becomes ordinary input.                            |
| A steer-capable conversation turn is active  | Preserve input for the next turn. | Apply input to the active turn at its next safe boundary.                  |
| Active pinned turn lacks steering capability | Preserve input for the next turn. | Degrade safely to queue; never drop, fail open, or start a second session. |
| Active turn settles before steering commits  | Preserve input for the next turn. | Preserve it in original admission order as queue input for the next turn.  |

This feature initially targets resumable conversation sessions. An active
task-mode session cannot promise a next-turn fallback, so `"steer"` must be
rejected with a typed unsupported-policy error until task successors have a
durable design. `send()` must propagate that error and must not interpret it as
permission to start a second session.

### Turn identity and events

Successfully applied steering remains inside the active turn:

- the turn retains its existing `turnId`;
- no second `turn.started` event is emitted;
- the replacement input emits `message.received` under that turn;
- later step, message, tool, and terminal events continue the normal sequence;
- the turn eventually completes, fails, cancels, or parks exactly once.

If the input falls back to the queue, it is observed under the next turn and
that turn emits its own `turn.started` normally.

### Safe boundary

A steering request does not rewrite an executing atomic step. eve applies it
after the current model/tool boundary has settled or has been cooperatively
stopped safely. The implementation may use a soft abort notification to stop
obsolete provider work sooner, but authors cannot depend on whether a specific
provider or tool call finishes or aborts.

The public guarantee is:

1. completed side effects are never rolled back;
2. a steering delivery is applied before the active turn is allowed to settle,
   or it remains queued for a later turn;
3. it is never applied twice.

### Ordering

Every admitted delivery receives a durable sequence. Queue fallback preserves
that admission order.

Steering intentionally bypasses older queued input while an active turn can
accept it. For example, queued input A may remain for the next turn while a
later steering input B joins the current turn. If B cannot be applied and also
falls back to the queue, the next turn observes A before B.

Multiple steering deliveries are forwarded single-flight and applied in their
admission order. eve may coalesce adjacent steering deliveries at one safe
boundary as long as payload order and exactly-once behavior are preserved.
Internal acknowledgement timing must never change their fallback order.

### Delivery and continuation races

- Once `send()` resolves a continuation hook to a session, a concurrent
  `setContinuationToken()` cannot make that delivery fall through to
  `runtime.run()` or create another history.
- `send()` may start a session only after receiving the typed
  no-active-session outcome. Hook conflicts, steering failures, unsupported
  policy, serialization errors, and other runtime failures propagate.
- A terminal race has two valid outcomes: input is consumed by the active turn
  or remains queued. There is no gap in which neither side owns it.
- Retry and replay are idempotent by delivery id. Duplicate hook or step
  execution cannot duplicate model input.

### Input requests and descendants

Structured `inputResponses` retain their addressing semantics:

- a response naming an existing request routes to that request's owner;
- input queued before a later request cannot accidentally answer it;
- steering received while a request is open does not close the request unless
  it contains the matching response;
- a delivery containing both addressed responses and parent-local content
  routes the addressed parts first, then applies `turnPolicy` to the remainder;
- responses for delegated children continue through existing child routing;
  any parent-local remainder retains the source delivery id and sequence.

Steering a parent does not cancel delegated children. Existing child results,
authorization state, and runtime-action reads remain pending. Replacement
input may resolve a child request or continue the parent according to the same
routing rules used for ordinary delivery.

### Adapter projection

`turnPolicy` is runtime routing metadata and is not part of the authored
adapter payload. The adapter still projects the delivery into a harness
`StepInput`.

Explicit steering cannot be silently swallowed because an adapter returns
`undefined`: eve falls back to the standard message/input-response projection
for that delivery. Structurally empty steering is normalized consistently with
new-session input. The harness marks the projected replacement input with its
existing internal `steering: true` marker so deferred input, compaction, and
history logic can distinguish it from an ordinary continuation.

Any future adapter contract that distinguishes “no custom projection” from
“handled without model input” should be designed separately. It is not an
additional `turnPolicy` value.

### Cancellation and side effects

Steering and cancellation are independent operations:

| Operation             | Replacement input | Turn identity | Terminal boundary                       |
| --------------------- | ----------------- | ------------- | --------------------------------------- |
| `turnPolicy: "queue"` | Next turn         | New turn      | Current turn settles normally           |
| `turnPolicy: "steer"` | Active turn       | Same turn     | No cancellation event                   |
| `cancel(...)`         | None              | Ends turn     | `turn.cancelled` then `session.waiting` |

If cancellation wins before a steering delivery is consumed, that delivery
remains queued for the next conversation turn. If the turn consumes the input
first and cancellation arrives afterward, the input belongs to the cancelled
turn and is not replayed automatically. Durable command ordering, not process
timing, determines which outcome occurred.

Partial model output already emitted remains on the stream. Completed tool,
channel, sandbox, and external effects remain completed. Steering and
cancellation are not rollback mechanisms.

## Clean-slate ownership model

The session driver must be the sole durable owner of admitted input. The active
turn receives a lease; ownership does not move merely because a private inbox
received the payload.

```text
public continuation hook
          │
          ▼
session driver admission ledger
  id + sequence + payload + requested policy
          │
          ├── queue ─────────────────────────────► next turn
          │
          └── lease steering delivery by id
                         │
                         ▼
                per-turn command inbox
                         │
                         ▼
                    active turn
                         │
                         └── consumed | released | remainder
                                      │
                                      ▼
                           update the original ledger entry
```

The ledger preserves position while an entry is leased:

- `consumed` removes the entry after the turn durably incorporates it into a
  step or routes it to the addressed child;
- `released` leaves it in place and changes effective policy to `queue`;
- `remainder` replaces the entry payload while retaining its id and sequence;
- terminal settlement releases every unresolved lease before selecting the
  next turn.

There are no “return to front/back” operations and no reconstruction with
`push()` or `unshift()`. The session driver is the only component that changes
effective policy from steering to queue.

The turn may expose one neutral, per-turn command inbox for input-bearing
commands such as steering and requested delivery. This does not mean steering
reuses the cancellation hook: hard cancellation and soft steering retain
different controllers, reasons, settlement behavior, and payload types. Share
low-level hook mechanics only where their replay and disposal rules are truly
identical.

### Step notification state

The active step needs to distinguish steering that was already pending when
the step began from steering that arrived while it was running:

```ts
interface TurnSteeringState {
  readonly pending: boolean;
  readonly signal?: AbortSignal;
}

interface TurnStepInput {
  readonly steeringState?: TurnSteeringState;
}
```

`pending` prevents settlement before already-admitted replacement input is
applied. `signal.aborted` wakes settlement checks when input arrives during the
step. Keep `StepInput.steering?: true` as the separate harness marker meaning
“this concrete input is replacement input.” Naming the control object
`steeringState` avoids giving two adjacent layers incompatible fields named
`steering`.

Workflow serializes nested abort signals across step boundaries, but eve must
retain a focused live-signal integration test so an upstream serializer change
cannot silently turn the signal into a plain object.

### Single-flight and terminal authority

- At most one input-bearing lease is outstanding to a turn at a time. The
  driver may continue admitting queue entries but does not forward another
  command until the current lease has a disposition.
- Receipt is not consumption. The turn reports `consumed` only at the durable
  boundary where the input is incorporated or routed.
- A stale disposition id cannot clear a current lease.
- The turn owns its normal result; the driver owns unresolved ledger entries.
  A terminal result therefore carries dispositions or remainders, never an
  untyped array to splice back into a buffer.
- Turn teardown disposes pending reads without awaiting iterator shutdown that
  can remain suspended forever.

### Durable versions and rollout

Separate the durable driver-to-turn seed from runtime-only step input. Abort
signals and `steeringState` are constructed inside the pinned turn workflow;
they do not belong in the durable migration type unless they actually cross
the driver-to-turn wire.

Any change to the durable turn seed or control protocol must update its version
and migration tests. Rollout uses additive capability negotiation:

- a latest driver can identify a steer-capable turn before leasing steering;
- a pinned driver or turn that omits the capability safely treats steering as
  queued input;
- no deployment combination interprets a new control payload as authored user
  input.

## Implementation sequence

Land this through independently reviewable boundaries.

1. **Workflow spike:** prove one per-turn input command can arrive while
   `turnStep` is active, drive the soft notification signal live, replay once,
   and settle a terminal race without a late disposition.
2. **Admission ledger:** replace raw driver buffering with id/sequence entries
   and lease/disposition operations while preserving existing queue and HITL
   behavior. No public steering API yet.
3. **Internal steering:** add the private command, `steeringState`, adapter
   projection rule, capability negotiation, and same-turn continuation tests.
   Existing cancellation remains unchanged.
4. **Public API:** expose `TurnPolicy`, `SendOptions.turnPolicy`, low-level
   delivery plumbing, Chat SDK propagation, custom-channel docs, and a patch
   changeset.
5. **E2E:** exercise the feature from a custom channel using only public APIs,
   then enable steering selectively in built-in channels only through separate
   product decisions.

Each implementation PR must be independently reviewable and leave queue-only
behavior complete.

## Verification

### Public behavior

- default queue behavior is unchanged;
- steering keeps one `turnId`, one `turn.started`, and emits replacement
  `message.received` before settlement;
- no-session, parked-session, pinned-old-turn, terminal-race, and task-mode
  outcomes match the state matrix;
- cancellation remains a hard stop with no replacement input;
- built-in channels do not opt in accidentally.

### Ownership and ordering

- queue A followed by steering B yields A then B if B falls back, regardless
  of whether the turn received B before terminating;
- multiple steering deliveries apply or fall back exactly once in admission
  order;
- stale and duplicate dispositions cannot clear or duplicate the active lease;
- continuation rekey, hook disposal, retry, and replay cannot create a second
  session or lose an admitted delivery;
- partial child routing preserves the source entry id and sequence.

### Step and harness integration

- nested live steering signal crosses the Workflow step boundary;
- already-pending state prevents park or completion without manufacturing a
  pre-aborted signal;
- adapter `undefined` falls back to the original steering input;
- steering during model, tool, authorization, input-request, runtime-action,
  and delegated-child waits preserves their pending state;
- structurally empty input follows new-session normalization;
- no late steering acknowledgement or disposition is emitted after terminal
  teardown.

### Repository checks

Run focused unit and integration tests for the admission ledger, turn command
receiver, workflow step, turn workflow, tool loop, HITL, cancellation, and
descendant routing. Public exposure also requires typecheck, lint, invariant
guard, docs validation, the full unit tier, and a deterministic hosted e2e
fixture.

## Out of scope

- Whole-session cancellation or `/new`.
- Retraction of streamed output or completed side effects.
- A public `interrupt`, `replace`, `supersede`, or priority enum.
- Multiple concurrent leases to one turn.
- Automatic debounce or latest-message policy in built-in channels.
- Task-mode successor sessions.
- An adapter handled/suppressed result protocol beyond the steering fallback
  rule above.

## Success criteria

- Channel authors choose only between standard `queue` and `steer` input
  policies and use `cancel()` for a stop action.
- Every successfully admitted delivery is either durably consumed by the
  active turn or retained by the driver for a later turn, never both and never
  neither.
- Internal acknowledgement timing cannot affect ordering.
- Steering does not require cancellation-hook semantics or expose another
  cancellation name.
- Public behavior is documented independently of Workflow hook layout, and
  queue-only behavior remains correct after every landing stage.
