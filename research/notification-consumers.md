---
issue: https://github.com/vercel/eve/issues/1170
status: proposed
last_updated: "2026-07-24"
---

# Notification consumers

## Summary

eve's durable session stream is the natural propagation backbone: producers
append, consumers derive — independently, at their own pace, without
producers knowing them. Followers (TUI, web clients, evals) already work
this way. Everything else is welded to the producer's call stack: the emit
path invokes the channel adapter and the remote-callback forwarder inline,
so those consumers only run while the producer's compute is awake.

For notification-class events — a child's
`authorization.required`/`authorization.completed` surfaced on the caller's
stream — the weld fails concretely:

- Delivery works only while the caller's turn is parked at its inbox;
  otherwise `resumeHook` throws and the event is silently dropped.
- One rendering-only event resumes the session workflow: context
  deserialization, session hydration, a journaled step.
- Local and remote children take different paths; channels render twice.
- Adapter state lives in the session workflow's cursor, so nothing else can
  safely invoke a channel.

v1 moves these events to a per-session **consumer** run. It adds **no new
queue wakes** and **no public API**, and it is the on-ramp for every event
class that should propagate without waking a session.

Vocabulary: the **caller** hosts the parent session; the **callee** is the
remote deployment running a delegated task.

## The notification event

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

Local and remote children surface identically. Invariants: notification
events never enter model history or session state, never resume the session
workflow, and never produce an input request. The framework curates the
propagated types (`authorization.*` in v1).

## Wake accounting

Per event, today vs v1:

| lane                          | today                                         | v1                                     |
| ----------------------------- | --------------------------------------------- | -------------------------------------- |
| callee → caller forwarding    | inline `await fetch` inside the emitting step | same POST, deferred off the step       |
| caller receiving remote event | queue wake of the **session workflow**        | queue wake of the **consumer** (light) |
| local child event surfacing   | queue wake of the session workflow            | queue wake of the consumer             |

The caller already pays a wake per notification; v1 redirects it at a run
that hydrates nothing but channel context. A callee-side consumer would be
the only genuinely new wake, so v1 has none.

## Caller side: the consumer run

```
CALLER   POST /eve/v1/callback/:token {status:"notification", event}
           └─► resumeHook(<sessionId>:notify)
                 └─► [queue] ──wake──► consumer run (no session hydration)
                       ├─► existing adapter event handler ──► e.g. Slack API
                       └─► append subagent.event ──► durable stream ──► followers
```

The session's entry workflow starts one consumer run, handing it the stream
writable — the same cross-run handoff turns get — and the serialized
channel context. The consumer parks on `<sessionId>:notify`; each delivery
is one journaled step: run the channel's **existing** adapter event handler
(the same one the proxy step invokes today, so channels change nothing) and
append the wrapped event to the stream.

The engine supplies the delivery properties: ordering (hook), at-least-once
(queue retry), exactly-once side effects (step journal), duplicate-run
safety (ownership claim). Adapter state mutated here persists in the
consumer's own run state — e.g. the Slack `ts` posted on `required`, edited
on `completed`. Session state is read-only to it.

Producers are one fire-and-forget call:

- The callback route validates against the closed notification schema,
  wraps, rings, returns 202 — always, once well-formed. A disposed consumer
  (session over) throws at the producer, which logs and drops. Nothing
  anywhere retries a notification.
- The local subagent proxy rings the same hook instead of resuming the
  session workflow.

The driver owns the lifecycle: start with the session, dispose with it.
Lazy start (first delivery creates the run) is the lever if start cost
matters.

### Where consumer runs execute

Registered as `workflow//eve//notificationConsumer` beside the entry and
turn workflows in the compiled bundle; executes as queue-driven invocations
of the caller's own deployment — the local world in dev, the workflow
backend on Vercel. Started plainly, without latest-deployment routing: it
holds the entry's stream writable and channel context, so it must live and
die with the entry's deployment.

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
  hold a copy. Audit what adapters mutate on notification-class events and
  whether divergence can matter for rendering.
- **Callee deferral primitive.** `waitUntil` semantics differ between the
  dev host and Vercel functions.
- **Consumer start cost.** Eager vs lazy — measure first.
