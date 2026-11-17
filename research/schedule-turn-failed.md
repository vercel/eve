---
issue: https://github.com/vercel/eve/pull/6552
status: proposed
last_updated: "2026-11-17"
---

# Pause a schedule when its turn fails

> **AI status:** Written entirely by AI; human review pending.

## Summary

A dynamic schedule's `run` sends a message to a channel, and that message starts a session. eve
calls `run` with a [`ScheduleHandle`][handle], so `run` can pause or delete the schedule. It does
that before it sends anything. When a failure shows up later, inside the turn, no authored code
holds the handle.

Some failures repeat on every occurrence. Take an agent that charges each person's scheduled runs
to that person's own AI Gateway budget. Once the budget is spent, the first model call of every
later run fails the same way, so the agent should pause the schedule on the first failure and tell
the person once. Today the turn fails, `run` has already returned, and the schedule keeps firing.

This doc proposes `turnFailed`, a handler on `defineDynamicSchedules` next to `run`. eve calls it
when a scheduled turn fails, and passes it the same `ScheduleHandle` as `run`. The schedule
definition keeps its control over the schedule, and eve decides when to call it.

## Authoring API

```ts
import { defineDynamicSchedules } from "eve/experimental/schedules";

export default defineDynamicSchedules({
  inputSchema: TaskInput,
  auth: ({ principal }) => currentAccess(principal),
  async run({ payload, occurrence, to }) {
    await to(slack, { channelId: payload.channelId }).send(prompt(payload, occurrence));
  },
  async turnFailed({ error, payload, occurrence, auth, schedule }) {
    if (error.code !== "BUDGET_SPENT") return;
    await schedule.disable();
    await notifyRunner(auth, payload, "Your budget is used up, so I paused this task.");
  },
});
```

`turnFailed` receives `ScheduleTurnFailedArgs`, exported from `eve/experimental/schedules`:

| Field        | Type                         | Purpose                                                                           |
| ------------ | ---------------------------- | --------------------------------------------------------------------------------- |
| `error`      | `ErrorInfo`                  | The failure's error: from `turn.settled`, or from `session.ended` when terminal.  |
| `occurrence` | `ScheduleOccurrenceIdentity` | The occurrence that started the turn. Its `executionId` keys idempotent effects.  |
| `auth`       | `SessionAuthContext`         | The occurrence's auth, as the definition's `auth` resolved it.                    |
| `payload`    | `TPrepared`                  | The schedule's stored payload when `turnFailed` runs, including any later update. |
| `schedule`   | `ScheduleHandle`             | `disable()` and `delete()`, as in `run` and `auth`.                               |
| `sessionId`  | `string`                     | The session of the failed turn.                                                   |

A named scope can replace `turnFailed`, as it replaces `run`.

## Behavior

### Which turns

eve calls `turnFailed` for a turn when both hold:

- The turn's context carries the schedule's provenance: the collection, the instance, and the
  occurrence. eve sets these keys when it dispatches an occurrence ([`channel/schedule.ts`][keys]),
  and they reach the turn as `ctx.session.schedule` ([`session-schedule.ts`][provenance]).
- The turn settles with `outcome: "failed"`, or the session ends with `outcome: "failed"` and the
  turn as its cause. Both come from the same failure path ([`transitions.ts`][fail]).

eve doesn't call it for:

- **A cancelled turn.** A person's stop and a hook's `ctx.cancel()` both settle with
  `outcome: "cancelled"`. The author's own code chose to stop, so the schedule has nothing to learn.
- **A completed turn.** A turn that answers with an apology still completed.
- **A failure before any turn.** `auth` returning `null`, `run` throwing, and an exhausted retry
  budget already reach `events["occurrence.failed"]` ([consumer route][occurrence-failed]).

### How often

An occurrence starts a fresh session for each send ([`channel/schedule.ts`][fresh]), so each failed
session gets one call. A `run` that sends to two channels can get two calls for one occurrence.
`schedule.disable()` is idempotent, and `occurrence.executionId` keys other effects, as the docs
already advise for `run`.

### Where it runs

eve runs `turnFailed` in the session's workflow, at the point where hooks see the failure
([hooks guide][hooks]). A failure that leaves the session open settles the turn, and eve calls
`turnFailed` after it saves the `turn.settled` line. A terminal failure, such as a gateway
configuration error ([`errors.ts`][terminal]), emits no `turn.settled`: `fail()` saves
`session.ended` with the error and `cause: { turnId }` ([`facts.ts`][ended]), and eve calls
`turnFailed` after that line. A replayed step doesn't call it a second time.

If `turnFailed` throws, eve logs the error and doesn't retry. The turn has already failed, and the
next occurrence fires as scheduled. This matches how eve treats a hook that throws between turns.

### One-time schedules

A `single` schedule fires once, so `disable()` changes nothing. `delete()` still removes the
record, and `turnFailed` can notify the person either way.

## Design

eve has most of the pieces already:

1. **Provenance.** The turn's context holds the collection, the instance, and the occurrence's
   `executionId` ([`channel/schedule.ts`][keys]). `ScheduleOccurrenceIdentity` also requires
   `name`, `scheduleId`, and `scheduledAt` ([`subscription.ts`][occurrence-identity]). eve adds the
   provider namespace, `scheduleId`, and `scheduledAt` to the same scope at dispatch, and carries
   them through `delivery.schedule` and `RunInput.schedule` to the turn. The provider needs the
   namespace to act on the schedule; today eve derives it from the stored scope at dispatch
   ([`dispatch-occurrence.ts`][namespace]), and the turn can't reach that scope. `ScheduleRecord`
   has no per-occurrence time ([`subscription.ts`][record]), so `scheduledAt` can only come from
   dispatch.
2. **The definition.** eve loads the collection's definition from the bundle by collection id, as
   the occurrence consumer does.
3. **The handle.** eve builds `disable()` and `delete()` as it does for `run`
   ([`dispatch-occurrence.ts`][dispatch-handle]), from the collection, the namespace, and the
   instance.
4. **The payload.** eve reads the stored schedule through the provider and passes its prepared
   payload. Session context doesn't carry the payload, and it can be up to 64 KB.

The handler has no `scope` check, for the reason the handle on `run` has none: an occurrence acts
for the schedule, not for a caller ([`ScheduleHandle`][handle]).

## Decisions and alternatives considered

### A handler on the definition

`auth` already pauses a schedule this way: it calls `schedule.disable()` before it returns `null`
([`auth`][auth]). `turnFailed` gives the turn's failures the same shape. The definition declares
what happens, eve decides when, and the handle stays with the definition.

### `turnFailed`, not `failed` or an event

`failed` would sit next to `events["occurrence.failed"]` and read as the same thing, though one
covers the occurrence and the other the turn it starts. `events` handlers only report, and none of
them receives a handle, so a new event would either break that pattern or leave the author with no
way to pause.

### `currentSchedule()`

A function returning a handle for the current session's schedule. Any hook, channel, or tool in a
scheduled session could then pause or delete the schedule, including model-reachable code. The
handler keeps that power with the definition.

### Letting a scheduled session's scope disable its own schedule

The management client could allow `disable` when the session's schedule matches the target. That
widens the authorization policy for every caller in a scheduled session, and the scope resolver
would need to compare collections and instances to stay narrow.

### A client map in the author's code

The author could bind schedule clients and call `disable` from a channel or hook. The schedule
definitions import the channel to send, so the channel importing the definitions back creates an
import cycle. Lazy imports break the cycle and add a second path to the same handle.

## Coverage

- A failed scheduled turn calls `turnFailed` once, with the error, occurrence, auth, payload, and a
  handle that disables the schedule.
- A session that ends with a failure, with the turn as its cause, calls it too.
- A cancelled turn, a completed turn, and a turn without schedule provenance don't call it.
- A failure before any turn calls `events["occurrence.failed"]` and not `turnFailed`.
- A replayed step doesn't call `turnFailed` again.
- A thrown `turnFailed` logs and leaves the next occurrence unaffected.
- A named scope's `turnFailed` replaces the definition's.

[handle]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/public/schedules/subscription.ts#L275-L284
[auth]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/public/schedules/subscription.ts#L403-L416
[keys]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/channel/schedule.ts#L107-L111
[fresh]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/channel/schedule.ts#L140-L151
[provenance]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/context/session-schedule.ts
[fail]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/harness/session-machine/transitions.ts#L170-L196
[occurrence-failed]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/internal/nitro/routes/schedule-collection-consumer.ts#L110-L128
[dispatch-handle]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/runtime/schedules/dispatch-occurrence.ts#L51-L58
[namespace]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/runtime/schedules/dispatch-occurrence.ts#L74-L90
[hooks]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/docs/guides/hooks.md#what-happens-when-a-hook-throws
[terminal]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/harness/model-call/errors.ts#L222-L228
[ended]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/harness/facts.ts#L43-L65
[occurrence-identity]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/public/schedules/subscription.ts#L75-L91
[record]: https://github.com/vercel/eve/blob/8f522a3728c8de2c6c8ce5056288d19730314fc5/packages/eve/src/public/schedules/subscription.ts#L139-L148
