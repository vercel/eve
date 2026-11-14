---
issue: https://github.com/vercel/eve/issues/6410
status: in-progress
last_updated: "2026-11-13"
---

# Posted reply and current schedule

## Summary

Authored code sometimes acts on eve's own work. A Slack renderer edits its reply after the
turn settles, and a session from a schedule's occurrence stops that schedule.
Neither has a supported path today. This proposal returns the posted message from
`postCompletedSlackReply` and adds `currentSchedule()` to `eve/experimental/schedules`.

## Posted Slack reply

```ts
const posted = await postCompletedSlackReply(ctx.channel, { blocks, markdown });
if (posted) {
  const channel = ctx.channel.slack.channelId;
  await ctx.channel.slack.request("chat.update", { channel, ts: posted.id, blocks });
}
```

| eve posts                     | Returns              |
| ----------------------------- | -------------------- |
| Your blocks                   | `SlackPostedMessage` |
| Your Markdown                 | `SlackPostedMessage` |
| The `eve-response.md` snippet | `undefined`          |
| Nothing: the root is deleted  | `undefined`          |

A snippet upload can post an anchor note and a file, so eve returns no single message for it.
Callers that ignore the result keep working.

## Current schedule

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
schedule's provenance, so the new session keeps it. `currentSchedule()` reloads the collection's
definition from the compiled agent and calls its provider with that namespace.

```text
occurrence ─▶ dispatcher records collection, name, namespace ─▶ session starts
session ─▶ currentSchedule() ─▶ provider.disable(namespace, name)
```

## Boundaries

- A later message from a person clears the schedule's provenance, the namespace included, so
  `currentSchedule()` returns `undefined` after a person writes in. The occurrence's own message
  keeps it.
- The protocol and `SessionSchedule` stay the same. The namespace lives in eve's internal
  context only.
