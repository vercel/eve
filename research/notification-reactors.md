---
issue: https://github.com/vercel/eve/issues/1170
status: proposed
last_updated: "2026-07-24"
---

# Notification reactors

## Summary

Event delivery is currently welded to the producer's call stack: the emit
path inside a workflow step synchronously invokes the channel adapter and
the remote-callback forwarder before writing the durable stream. Consumers
only run while the producer's compute is awake. For notification-class
events — a child's `authorization.required`/`authorization.completed`
surfaced on the caller's stream — this causes real failures:

- A notification callback lands only while the caller's turn is parked at
  its inbox; parked-for-input or between turns, `resumeHook` throws and the
  event is silently dropped.
- Delivering one rendering-only event resumes the session workflow: context
  deserialization, session hydration, and a journaled step.
- Local and remote children take different producer paths, so channels
  implement the same rendering twice.
- Adapter state persists through the session workflow's cursor, so nothing
  outside it can safely invoke a channel.

The fix is a producer/consumer split built from existing engine primitives,
scoped so that v1 adds **no new queue wakes**: the deployment that hosts the
parent session gets one **reactor** — a small companion workflow run parked
on a notify hook — and it replaces a wake that already happens today. The
outbound side keeps its direct per-event POST, moved off the emitting
step's critical path.

Vocabulary: the **caller** is the deployment where the parent session lives
(the one the user watches); the **callee** is the remote deployment running
a delegated task. A child's authorization event is born on the callee and
must reach the caller's stream and channel.

## The notification event

Notification-class events are rendering-only child telemetry. They appear on
the parent stream wrapped as the existing (currently producer-less)
`subagent.event`, which carries the correlation the current re-emit drops:

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

One path: local and remote children both surface as `subagent.event`
delivered through the caller's reactor. Channel authors and clients handle
exactly one shape.

Invariants:

- Notification events never enter model history or session state, never
  resume the session workflow, and never produce an input request.
- The framework curates which child event types propagate
  (`authorization.required`, `authorization.completed` in v1).

## Wake accounting

The design is shaped by what each lane costs today, per event:

| lane                          | today                                         | v1                                    |
| ----------------------------- | --------------------------------------------- | ------------------------------------- |
| callee → caller forwarding    | inline `await fetch` inside the emitting step | same POST, deferred off the step      |
| caller receiving remote event | queue wake of the **session workflow**        | queue wake of the **reactor** (light) |
| local child event surfacing   | queue wake of the session workflow            | queue wake of the reactor             |

The caller side already pays a wake per notification; v1 redirects it at a
run that hydrates nothing but channel context. The callee side is the only
lane where a reactor would introduce a wake that does not exist today, so
v1 does not put one there.

## Caller side: the reactor run

```
CALLER   POST /eve/v1/callback/:token {status:"notification", event}
           └─► resumeHook(<sessionId>:notify)
                 └─► [queue] ──wake──► reactor run (no session hydration)
                       ├─► append subagent.event ──► durable stream ──► followers
                       │                                      (TUI, web, evals)
                       └─► channel.notification(event, ctx) ──► e.g. Slack API
```

The session's entry workflow starts one reactor run, handing it the
session's stream writable — the same cross-run handoff the entry already
performs for turn workflows — and the serialized channel context. The
reactor parks on `<sessionId>:notify` and loops: for each delivered
notification, one journaled step appends the wrapped event to the stream
and invokes the channel's `notification` member.

The engine supplies every delivery property: per-hook ordering,
at-least-once via queue retry, exactly-once side effects via step
journaling, duplicate-run safety via hook ownership claims. Because the
reactor is a durable run with a single consumer, it may keep reactor-local
state across events — e.g. the Slack message `ts` posted for
`authorization.required`, edited in place when `authorization.completed`
arrives. Session state remains read-only to it.

Producers are one fire-and-forget call and know nothing about consumers:

- The callback route validates a notification against the closed schema,
  wraps it, rings the reactor, and returns 202 — always, once the payload
  is well-formed. A disposed reactor (session over) throws at the producer,
  which logs and drops. Nothing anywhere retries a notification.
- The local subagent proxy delivers curated child events to the same
  reactor instead of resuming the session workflow to re-emit them.

The driver owns the lifecycle: the reactor starts with the session and is
disposed when the session completes. If per-session start cost matters, the
lever is lazy start — the first delivery creates the run.

## Callee side: deferred direct forwarding

```
CALLEE   turn step (compute already awake)
           emit(authorization.required)
             ├─► write own durable stream
             └─► waitUntil(fetch(caller callback URL))   ← fire, don't await
```

No reactor, no new wake. The only change from today is that the POST no
longer rides the emitting step's critical path: currently the caller's
round-trip latency is awaited inside the emit, taxing the callee's step per
event. Delivery remains best-effort exactly as today — an unreachable
caller is logged and never fails the turn.

The termination lane is untouched on both sides: terminal callbacks still
resume the parked turn through the turn inbox with durable, exactly-once
semantics.

## Frequency admission rule

v1's curated set (`authorization.*`) fires a handful of times per session,
gated by human sign-ins. Higher-frequency event types — the reserved
`"working"` progress status, proxied HITL — may join the lane only with
coalescing in place: the reactor catches up over a cursor on wake, so N
events during one invocation cost one wake, not N. Until a type meets that
bar, it does not enter the lane.

## Public authoring API

The only new public surface is one optional channel member:

```ts
export default defineChannel({
  // Existing members omitted.
  async notification(event, ctx) {
    // event: SubagentChildEventStreamEvent
    // ctx.state: read-only snapshot of this channel's persisted state
    if (event.data.event.type !== "authorization.required") return;
    await postSignInMessage({
      channel: ctx.state.slackChannelId,
      url: event.data.event.data.authorization?.url,
      correlationKey: event.data.callId,
    });
  },
});
```

- `ctx.state` is a read-only snapshot of the channel's persisted session
  state (e.g. which Slack thread this session lives in). There is no state
  write-back to the session.
- Errors are logged and retried by the engine's step policy, and never
  affect the session.
- The member is optional; channels without it simply don't render
  notifications. Stream followers (TUI, web frontends, eval clients) need
  no member — they see the reactor's stream append directly.

## Out of scope

- A callee-side reactor. Deferred until an event type passes the frequency
  admission rule and makes the extra wake worth buying.
- Migrating the existing emit-coupled consumers (adapter transforms, hooks,
  dynamic resolvers) to reactors. They converge consumer-by-consumer later;
  this document only moves notification-class events.
- Public reactor registration. The channel `notification` member is the
  whole authoring surface until a second consumer class needs more.
- Proxied HITL (`input_required`) and progress (`working`) forwarding. The
  lane is shaped for them; they are not in v1.

## Open questions

- **Adapter transform audit.** Channel adapters can rewrite events pre-write
  today. Nothing load-bearing is known to depend on mutating authorization
  events before persistence, but this must be verified before the local
  proxy lane switches to reactor delivery.
- **Deferral primitive on the callee.** `waitUntil` semantics differ across
  the local dev host and Vercel functions; pick the mechanism that
  guarantees the deferred POST survives the step's response without
  re-blocking it.
- **Reactor start cost.** One extra parked run per session, or lazy start on
  first delivery. Measure before choosing.
