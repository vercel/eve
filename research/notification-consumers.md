---
issue: https://github.com/vercel/eve/issues/1170
status: proposed
last_updated: "2026-07-24"
---

# Notification consumers

## Summary

The session's durable stream is eve's natural event-propagation backbone:
producers append, and everything downstream — channel rendering, clients,
cross-deployment forwarding — can derive from it independently, each at its
own pace, without producers knowing consumers exist. Followers already work
this way. This document moves the first non-follower consumers onto that
model and establishes the pattern the remaining event propagation can
converge on: producers just write; consumption is a separately scheduled
concern.

Today, non-follower delivery is instead welded to the producer's call
stack: the emit path inside a workflow step synchronously invokes the
channel adapter and the remote-callback forwarder before writing the
stream, so those consumers only run while the producer's compute is awake.
For notification-class events — a child's
`authorization.required`/`authorization.completed` surfaced on the
caller's stream — the coupling causes real failures:

- A notification callback lands only while the caller's turn is parked at
  its inbox; parked-for-input or between turns, `resumeHook` throws and the
  event is silently dropped.
- Delivering one rendering-only event resumes the session workflow: context
  deserialization, session hydration, and a journaled step.
- Local and remote children take different producer paths, so channels
  implement the same rendering twice.
- Adapter state persists through the session workflow's cursor, so nothing
  outside it can safely invoke a channel.

The split is built from existing engine primitives and scoped so that v1
adds **no new queue wakes**: the deployment that hosts the parent session
gets one **consumer** — a small companion workflow run parked on a notify
hook — and it replaces a wake that already happens today. The outbound side
keeps its direct per-event POST, moved off the emitting step's critical
path. Beyond fixing notifications, the lane is the on-ramp for every event
class that should propagate without waking a session: progress
(`"working"`) and proxied HITL join it under the frequency admission rule,
and the emit-coupled consumers converge onto it one at a time.

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
delivered through the caller's consumer. Channel authors and clients handle
exactly one shape.

Invariants:

- Notification events never enter model history or session state, never
  resume the session workflow, and never produce an input request.
- The framework curates which child event types propagate
  (`authorization.required`, `authorization.completed` in v1).

## Wake accounting

The design is shaped by what each lane costs today, per event:

| lane                          | today                                         | v1                                     |
| ----------------------------- | --------------------------------------------- | -------------------------------------- |
| callee → caller forwarding    | inline `await fetch` inside the emitting step | same POST, deferred off the step       |
| caller receiving remote event | queue wake of the **session workflow**        | queue wake of the **consumer** (light) |
| local child event surfacing   | queue wake of the session workflow            | queue wake of the consumer             |

The caller side already pays a wake per notification; v1 redirects it at a
run that hydrates nothing but channel context. The callee side is the only
lane where a consumer would introduce a wake that does not exist today, so
v1 does not put one there.

## Caller side: the consumer run

```
CALLER   POST /eve/v1/callback/:token {status:"notification", event}
           └─► resumeHook(<sessionId>:notify)
                 └─► [queue] ──wake──► consumer run (no session hydration)
                       ├─► existing adapter event handler ──► e.g. Slack API
                       └─► append subagent.event ──► durable stream ──► followers
                                                           (TUI, web, evals)
```

The session's entry workflow starts one consumer run, handing it the
session's stream writable — the same cross-run handoff the entry already
performs for turn workflows — and the serialized channel context. The
consumer parks on `<sessionId>:notify` and loops: for each delivered
notification, one journaled step runs the channel's **existing** adapter
event handler against the curated child event — the same handler the
session workflow's proxy step invokes for these events today, so channels
render with zero changes — and appends the wrapped `subagent.event` to the
stream.

There is no new channel API. Adapters keep receiving `authorization.*`
through the handler contract they already implement; the only thing that
changes is which run invokes them. Followers see the namespaced
`subagent.event` wrapper on the stream.

The engine supplies every delivery property: per-hook ordering,
at-least-once via queue retry, exactly-once side effects via step
journaling, duplicate-run safety via hook ownership claims. Adapter state
mutations made while handling a notification persist in the consumer's own
run state — the notification lane's adapter state lives with its single
consumer (e.g. the Slack message `ts` posted for `authorization.required`,
edited in place when `authorization.completed` arrives). Session state
remains read-only to the consumer.

Producers are one fire-and-forget call and know nothing about consumers:

- The callback route validates a notification against the closed schema,
  wraps it, rings the consumer, and returns 202 — always, once the payload
  is well-formed. A disposed consumer (session over) throws at the producer,
  which logs and drops. Nothing anywhere retries a notification.
- The local subagent proxy delivers curated child events to the same
  consumer instead of resuming the session workflow to re-emit them.

The driver owns the lifecycle: the consumer starts with the session and is
disposed when the session completes. If per-session start cost matters, the
lever is lazy start — the first delivery creates the run.

### Where consumer runs execute

The consumer is a framework-registered workflow function — a sibling of the
session entry and turn workflows, registered under a stable id
(`workflow//eve//notificationConsumer`) in the same compiled workflow bundle
at build time. It therefore executes wherever the session's other runs
execute: on the caller's own deployment, as ordinary queue-driven workflow
invocations — the local world in `eve dev`, function invocations of the
deployment via the workflow backend on Vercel. There is no new compute
surface, host, or process; a consumer invocation is indistinguishable from
a turn-workflow invocation at the infrastructure level.

Deployment pinning: the entry run starts the consumer plainly (no
latest-deployment routing), pinning it to the entry's own deployment. The
consumer holds the entry's stream writable and channel context, so it must
live and die with the entry — routing it to a newer deployment mid-session
would separate it from the handles it owns.

## Callee side: deferred direct forwarding

```
CALLEE   turn step (compute already awake)
           emit(authorization.required)
             ├─► write own durable stream
             └─► waitUntil(fetch(caller callback URL))   ← fire, don't await
```

No consumer run here, no new wake. The only change from today is that the POST no
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
coalescing in place: the consumer catches up over a cursor on wake, so N
events during one invocation cost one wake, not N. Until a type meets that
bar, it does not enter the lane.

## No new public API

Nothing changes for channel authors. Adapters keep implementing the same
event-handler contract; `authorization.*` events reach them exactly as
today, invoked by the consumer run instead of the session workflow. The
wrapped `subagent.event` is the stream representation only — followers and
clients see it; adapters are handed the curated child event their handlers
already understand. The whole design is internal plumbing plus one
protocol-level producer for the existing (currently producer-less)
`subagent.event` type.

## Out of scope

- A callee-side consumer. Deferred until an event type passes the frequency
  admission rule and makes the extra wake worth buying.
- Migrating the existing emit-coupled consumers (adapter transforms, hooks,
  dynamic resolvers) to consumers. They converge consumer-by-consumer later;
  this document only moves notification-class events.
- Any public consumer or channel surface. Consumer registration, if it ever
  becomes public, is future work driven by a second consumer class.
- Proxied HITL (`input_required`) and progress (`working`) forwarding. The
  lane is shaped for them; they are not in v1.

## Open questions

- **Adapter state divergence.** Notification-lane adapter state lives in the
  consumer run; the session workflow keeps its own copy for the events it
  emits. Audit which adapters mutate state on notification-class events and
  whether the two copies can disagree in a way that matters for rendering.
- **Deferral primitive on the callee.** `waitUntil` semantics differ across
  the local dev host and Vercel functions; pick the mechanism that
  guarantees the deferred POST survives the step's response without
  re-blocking it.
- **Consumer start cost.** One extra parked run per session, or lazy start on
  first delivery. Measure before choosing.
