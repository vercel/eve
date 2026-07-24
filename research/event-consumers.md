---
issue: https://github.com/vercel/eve/issues/1170
status: proposed
last_updated: "2026-07-24"
---

# Event consumers

## What this proposes

Normalize event consumption. Today the flow an event takes depends on who
consumes it. Followers (TUI, web clients, evals) derive from the durable
session stream: producers append, consumers read independently, at their
own pace. Channels and the remote-callback forwarder instead run inline in
the producer's emit path, so they only run while the producer's compute is
awake.

The proposal inverts that split. The harness funnels every event a single
way, and every consumer — channels included — consumes from a durable
delivery step. Once a delivery is accepted, it survives crashes and
redelivers until consumed (queue retry, journaled side effects) instead of
existing only for the duration of the producer's call stack. The price is
one extra hop per event; the [wake accounting](#wake-accounting) below
scopes v1 so that hop replaces a wake the caller already pays.

## Why

The first events to need this — a child's
`authorization.required`/`authorization.completed` surfaced on the caller's
stream — show the inline weld failing concretely. Receipts are pinned to
[#1167's head, `413ce48d`](https://github.com/vercel/eve/pull/1167), the
baseline that carries the mechanism:

- **The delivery hook rotates; producers hold a stale token.** The engine
  buffers deliveries on hooks: `resumeHook` durably appends a
  `hook_received` event to the owning run's log and re-queues the run —
  no one needs to be awaiting the hook yet — and it throws only for a
  missing or disposed hook or a terminal run
  (`@workflow/core@5.0.0-beta.36`, `dist/runtime/resume-hook.js`). But a
  session exposes no long-lived hook. Its delivery hook is keyed by the
  current turn's continuation token: the callee's callback URL captures
  that token at dispatch
  ([remote-agent-dispatch.ts:30](https://github.com/vercel/eve/blob/413ce48dff6d336a1e5e488ca51b6a918cb12e29/packages/eve/src/execution/remote-agent-dispatch.ts#L30)),
  the entry workflow rekeys the hook to a fresh token every time a turn
  parks
  ([workflow-entry.ts:251](https://github.com/vercel/eve/blob/0a8b63c53569776ac09602a0027e7913616e239f/packages/eve/src/execution/workflow-entry.ts#L251-L253)),
  and the retired hook is disposed immediately, so a delivery to its
  token gets `HookNotFoundError`
  ([session-delivery-hook.ts:37](https://github.com/vercel/eve/blob/0a8b63c53569776ac09602a0027e7913616e239f/packages/eve/src/execution/session-delivery-hook.ts#L37-L41)).
  The route surfaces that as a 404
  ([session-callback-route.ts:67](https://github.com/vercel/eve/blob/413ce48dff6d336a1e5e488ca51b6a918cb12e29/packages/eve/src/runtime/session-callback-route.ts#L67))
  and the callee logs and moves on
  ([session-callback-notification.ts:61](https://github.com/vercel/eve/blob/413ce48dff6d336a1e5e488ca51b6a918cb12e29/packages/eve/src/execution/session-callback-notification.ts#L61)).
  Why it matters: these events are how a person gets unblocked. Expected
  path: a remote child suspends on sign-in, the forwarded
  `authorization.required` becomes the sign-in prompt in the caller's
  channel, the person clicks, the child resumes. Divergence: the caller's
  turn also holds a pending approval — the #1167 hitl-collision shape —
  and that approval rekeyed the delivery hook, disposing the one whose
  token the child's callback URL still carries; the prompt 404s, and the
  only person who can unblock the child is never asked. Same failure on
  the way out: after the terminal callback resolves the call and the
  session rekeys for its next turn, the racing `authorization.completed`
  hits the disposed hook, and a card that did render stays frozen on
  "waiting". One curl verifies it: POST a well-formed notification to a
  retired callback token and read back
  `{"error":"Session callback not pending."}`.
- **Nothing redelivers.** Producers do emit from journaled steps, but a
  delivery failure never reaches the journal — deliberately, so an
  unreachable caller cannot fail the producing step: the remote POST
  failure is swallowed in the forwarder
  ([session-callback-notification.ts:61](https://github.com/vercel/eve/blob/413ce48dff6d336a1e5e488ca51b6a918cb12e29/packages/eve/src/execution/session-callback-notification.ts#L61)),
  and a throwing local forward is swallowed by `callAdapterEventHandler`
  ("adapter event handler threw — event swallowed",
  [adapter.ts:246](https://github.com/vercel/eve/blob/413ce48dff6d336a1e5e488ca51b6a918cb12e29/packages/eve/src/channel/adapter.ts#L246)).
  Retrying the producer's step would not help anyway: the POST is
  addressed to a retired token and rotation is one-way, so the address
  never becomes valid again — while the retry re-runs the step's other
  side effects. The child's own stream write is durable; the delivery
  isn't.
- **Delivery is heavyweight.** A rendering-only event — one whose entire
  effect is presentation, e.g. a child's `authorization.required` becoming
  the channel's sign-in prompt, never touching model history or session
  state — costs a queue wake of the parked turn workflow
  ([turn-workflow.ts:297](https://github.com/vercel/eve/blob/413ce48dff6d336a1e5e488ca51b6a918cb12e29/packages/eve/src/execution/turn-workflow.ts#L297))
  plus a journaled step that re-reads the durable session and
  deserializes the full context
  ([subagent-event-proxy-step.ts:51](https://github.com/vercel/eve/blob/413ce48dff6d336a1e5e488ca51b6a918cb12e29/packages/eve/src/execution/subagent-event-proxy-step.ts#L51))
  to invoke one adapter handler and write one stream event.
- **The same forwarding is implemented twice.** Local children forward
  through the subagent adapter's journaled hook step
  ([subagent-adapter.ts:140](https://github.com/vercel/eve/blob/413ce48dff6d336a1e5e488ca51b6a918cb12e29/packages/eve/src/execution/subagent-adapter.ts#L140)),
  remote callees through the callback POST plus route projection
  ([session-callback-notification.ts:14](https://github.com/vercel/eve/blob/413ce48dff6d336a1e5e488ca51b6a918cb12e29/packages/eve/src/execution/session-callback-notification.ts#L14)
  — self-described as "the callback-URL analog" of the former). Two
  transports, two implementations to keep in sync, divergent failure
  semantics (the local step rethrows, the remote swallows), converging
  only at the caller's inbox
  ([turn-workflow.ts:297](https://github.com/vercel/eve/blob/413ce48dff6d336a1e5e488ca51b6a918cb12e29/packages/eve/src/execution/turn-workflow.ts#L297)).
- **Channels are locked to the workflow.** Adapter state rides the
  workflow step's serialized context
  ([subagent-event-proxy-step.ts:113](https://github.com/vercel/eve/blob/413ce48dff6d336a1e5e488ca51b6a918cb12e29/packages/eve/src/execution/subagent-event-proxy-step.ts#L113)),
  so nothing outside the session workflow can safely invoke a channel.

v1 moves these events to a per-session **consumer** run. It adds **no new
queue wakes** and **no public API**, and it is the on-ramp for every event
class that should propagate without waking a session.

Vocabulary: the **caller** hosts the parent session; the **callee** is the
remote deployment running a delegated task.

## Comparison artifacts

Two runnable artifacts frame the decision:

- [#1167](https://github.com/vercel/eve/pull/1167) (reopened) — the
  baseline: child authorization events piped through today's continuation
  entry point, `resumeHook` into the session workflow's turn inbox. It
  shows the mechanism working end to end and hits every failure above. To
  keep it a clean baseline for the delivery path alone, it sheds its
  `eve/tools` authorization API exposure.
- A prototype of this proposal — the per-session consumer run described
  below, exercised against the same fixture evals.

## The propagated event

Rendering-only child telemetry, wrapped on the parent stream as the
existing (currently producer-less) `subagent.event`, which restores the
correlation the current re-emit drops:

```ts
interface SubagentChildEventStreamEvent {
  data: {
    callId: string;
    childSessionId: string;
    subagentName: string;
    event: HandleMessageStreamEvent; // authorization.* in v1
  };
  type: "subagent.event";
}
```

Local and remote children surface identically. Invariants: events on this
lane never enter model history or session state, never resume the session
workflow, and never produce an input request. The framework curates the
propagated types (`authorization.*` in v1).

## Wake accounting

Per event, today vs v1:

| lane                          | today                                         | v1                                     |
| ----------------------------- | --------------------------------------------- | -------------------------------------- |
| callee → caller forwarding    | inline `await fetch` inside the emitting step | same POST, deferred off the step       |
| caller receiving remote event | queue wake of the **session workflow**        | queue wake of the **consumer** (light) |
| local child event surfacing   | queue wake of the session workflow            | queue wake of the consumer             |

The caller already pays a wake per event; v1 redirects it at a run that
hydrates nothing but channel context. A callee-side consumer would be the
only genuinely new wake, so v1 has none.

## Caller side: the consumer run

```
CALLER   POST /eve/v1/callback/:token {status:"notification", event}
           └─► resumeHook(<sessionId>:events)
                 └─► [queue] ──wake──► consumer run (no session hydration)
                       ├─► existing adapter event handler ──► e.g. Slack API
                       └─► append subagent.event ──► durable stream ──► followers
```

The session's entry workflow starts one consumer run, handing it the stream
writable — the same cross-run handoff turns get — and the serialized
channel context. The consumer awaits `<sessionId>:events`, a hook whose
token is stable for the session's lifetime — producers stop chasing the
rotating turn token, and the engine's own hook buffering applies; each
delivery is one journaled **write step** (`event-consumer-write-step` — the run owns
receiving, the step owns the delivery's durable effects): run the channel's
**existing** adapter event handler (the same one the proxy step invokes
today, so channels change nothing) and append the wrapped event to the
stream.

The engine supplies the delivery properties: ordering (hook), at-least-once
(queue retry), exactly-once side effects (step journal), duplicate-run
safety (ownership claim). Adapter state mutated here persists in the
consumer's own run state — e.g. the Slack `ts` posted on `required`, edited
on `completed`. Session state is read-only to it.

Producers are one fire-and-forget call:

- The callback route validates against the closed schema of admitted
  events — on the wire they arrive as #1167's `status: "notification"`
  envelope class — wraps, rings, returns 202: always, once well-formed. A
  disposed consumer (session over) throws at the producer, which logs and
  drops. Producers never retry.
- The local subagent proxy rings the same hook instead of resuming the
  session workflow.

The driver owns the lifecycle: start with the session, dispose with it.
Lazy start (first delivery creates the run) is the lever if start cost
matters.

### Where consumer runs execute

Registered as `workflow//eve//eventConsumer` beside the entry and turn
workflows in the compiled bundle; executes as queue-driven invocations of
the caller's own deployment — the local world in dev, the workflow backend
on Vercel. Started plainly, without latest-deployment routing: it holds the
entry's stream writable and channel context, so it must live and die with
the entry's deployment.

## Callee side: deferred direct forwarding

```
CALLEE   turn step (compute already awake)
           emit(authorization.required)
             ├─► write own durable stream
             └─► waitUntil(fetch(caller callback URL))   ← fire, don't await
```

No consumer run, no new wake. The POST just moves off the emitting step's
critical path — today the caller's round-trip is awaited inside the emit.
Delivery stays best-effort. Termination is untouched on both sides: still
the durable turn-inbox resume.

## Frequency admission rule

`authorization.*` fires a handful of times per session, gated by human
sign-ins. Higher-frequency types — `"working"` progress, proxied HITL —
join the lane only with coalescing in place: cursor catch-up on wake, so N
events during one invocation cost one wake.

## No new public API

Adapters keep the event-handler contract they already implement; only the
run invoking them changes. `subagent.event` is the stream representation
for followers and clients; adapters receive the curated child event exactly
as today.

## Out of scope

- A callee-side consumer (blocked on the frequency admission rule).
- Converging the other emit-coupled consumers (adapter transforms, hooks,
  dynamic resolvers) — later, one at a time.
- Public consumer registration.
- `input_required` and `working` forwarding; the lane is shaped for them.

## Open questions

- **Adapter-state divergence.** The consumer and the session workflow each
  hold a copy. Audit what adapters mutate on events taking this lane and
  whether divergence can matter for rendering.
- **Callee deferral primitive.** `waitUntil` semantics differ between the
  dev host and Vercel functions.
- **Consumer start cost.** Eager vs lazy — measure first.
- **Event indexing.** A consumer with a cursor is an indexer, so this lane
  is the natural attachment point for one. v1 helps — accepted events
  reach the parent stream via a journaled append, with provenance restored
  by `subagent.event` — but the callee→caller wire stays best-effort, so
  an index over the parent stream alone cannot claim cross-deployment
  completeness. Decide whether that needs child-stream indexing or a
  durable cursor pull before public consumer registration.
