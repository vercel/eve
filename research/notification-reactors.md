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

The fix is a producer/consumer split built entirely from existing engine
primitives. Each session gets one **reactor**: a small companion workflow
run, started with the session, parked on its own hook. Producers deliver a
notification with one fire-and-forget `resumeHook` to that hook; the
reactor appends the event to the session stream and performs the side
effects. The session workflow is never woken for notifications.

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

One path: local and remote children both surface as `subagent.event`. The
local proxy step delivers to the reactor instead of re-emitting the raw
child event through the adapter; the remote lane arrives via the callback
route. Channel authors and clients handle exactly one shape.

Invariants:

- Notification events never enter model history or session state, never
  resume the session workflow, and never produce an input request.
- The framework curates which child event types propagate
  (`authorization.required`, `authorization.completed` in v1). The reserved
  `"working"` and `"input_required"` callback statuses are future tenants of
  the same lane.

## The reactor run

The session's entry workflow starts one reactor run per session, handing it
the session's stream writable — the same cross-run handoff the entry
already performs for turn workflows — and the serialized channel context.
The reactor parks on a notify hook derived from the session
(`<sessionId>:notify`) and loops:

```
for await (const notification of notifyHook) {
  "use step":
    1. append wrapped subagent.event to the session stream
    2. channel.notification(event, ctx)        // render (e.g. Slack)
    3. forward to callback URL                 // callee sessions only
}
```

The engine supplies every delivery property for free: per-hook ordering,
at-least-once via queue retry, exactly-once side effects via step
journaling, and duplicate-run safety via hook ownership claims. Because the
reactor is a durable run with a single consumer, it may keep reactor-local
state across events — e.g. the Slack message `ts` posted for
`authorization.required`, edited in place when `authorization.completed`
arrives. Session state remains read-only to it.

The driver owns the lifecycle: the reactor starts with the session and is
disposed when the session completes. After disposal the notify hook is
gone; a late delivery throws at the producer, which logs and drops.

## Producers just notify

Producers know that a notification lane exists — never who consumes it.

**Remote lane.** The caller-side callback route stops calling `resumeHook`
on the session workflow for notifications. It validates the payload against
the closed notification schema, wraps it, and delivers it to the reactor:

```
POST /eve/v1/callback/:token  { status: "notification", event, callId, ... }
  → validate → wrap → resumeHook(reactorToken, wrapped) → 202
```

Always 202 once the payload is well-formed. The handler has no lifecycle
awareness: a disposed reactor means the session is over and nobody is
rendering — the delivery is dropped and logged. Nothing anywhere retries a
notification.

**Local lane.** The local subagent proxy step and the callee's own emit
path deliver curated child events to the reactor with the same
fire-and-forget call, replacing the in-line adapter re-emit and
`forwardSessionCallbackNotification` respectively.

The termination lane is untouched: terminal callbacks still resume the
parked turn through the turn inbox with durable, exactly-once semantics.

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

## Data flow

```
callee deployment                      caller deployment
─────────────────                      ─────────────────
turn emits authorization.*
      │ resumeHook (fire-and-forget)
      ▼
[callee reactor] ── append ──► durable stream (callee)
      │ POST {status:"notification", ...}
      ▼
                        /eve/v1/callback/:token
                              │ validate → wrap → resumeHook
                              ▼
                        [caller reactor]
                          │           │
                    append to      channel.notification
                    durable stream    (Slack API)
                          │
                      followers (TUI, clients, evals)
```

## Out of scope

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
- **Reactor start cost.** One extra parked run per session. Parked runs are
  the engine's resting state, but sessions that never produce a
  notification still pay the start; measure, and if it matters, start the
  reactor lazily on first delivery.
