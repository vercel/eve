---
issue: https://github.com/vercel/eve/issues/6410
status: in-progress
last_updated: "2026-11-13"
---

# Current schedule

## Summary

A session from a dynamic schedule's occurrence sometimes needs to stop that schedule, for
example when the agent finds the task no longer applies. It has no supported path today: the
app keeps its own registry of schedule definitions and loosens its `scope` policy to reach the
schedule. This proposal adds `currentSchedule()` to `eve/experimental/schedules`.

## Authoring API

```ts
import { currentSchedule } from "eve/experimental/schedules";

const schedule = await currentSchedule();
await schedule?.disable();
```

`currentSchedule()` returns a `ScheduleHandle` like the one in `run`, for the schedule whose
occurrence started the session. It returns `undefined` when no dynamic schedule started the
session. Like the handle in `run`, it calls no `scope`: the session reaches only its own schedule.

The dispatcher records the schedule's provider namespace in the session's context, beside the
schedule's collection and name. A send from `run` passes the namespace on with the rest of the
schedule's provenance, and so does a subagent call, so both new sessions keep it.
`currentSchedule()` loads the collection's definition and calls its provider with that namespace
when the caller calls `disable()` or `delete()`.

```text
occurrence ─▶ dispatcher records collection, name, namespace ─▶ session starts
session ─▶ currentSchedule() ─▶ provider.disable(namespace, name)
```

## Boundaries

- A later message from a person clears the schedule's provenance, the namespace included, so
  `currentSchedule()` returns `undefined` after a person writes in. The occurrence's own message
  keeps it.
- A subagent sees `ctx.session.schedule` without the namespace, so `currentSchedule()` returns
  `undefined` there. A subagent's bundle may not deploy the collection, so its handle couldn't
  load the provider.
- The protocol and `SessionSchedule` stay the same. The namespace lives in eve's internal
  context only.
