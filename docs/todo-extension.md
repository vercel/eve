---
title: "Todo Extension"
description: "Give a session a checklist the model keeps current and sees before every model call while work is open."
---

`eve/extensions/todo` gives an agent a checklist for multi-step work. The model rewrites the list with one tool as it starts, finishes, or drops steps, and while any step is open, the list is shown to the model before every model call. The extension ships inside the `eve` package.

## Mount the extension

```ts title="agent/extensions/todo.ts"
export { default } from "eve/extensions/todo";
```

The extension takes no configuration.

## Tools and instructions

Mounted as `todo`, the extension contributes:

| Contribution       | Use                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `todo__write`      | Replaces the session's checklist. Each item has `content` and a `status`: `pending`, `in_progress`, `completed`, or `cancelled`.  |
| System instruction | Shows the checklist before every model call while at least one item is `pending` or `in_progress`. A finished list shows nothing. |

The list holds at most 50 items of up to 200 characters each. It lives in [state](./concepts/state), so it survives step boundaries, redeploys, and [compaction](./concepts/default-harness#compaction). Because the list is a [dynamic system instruction](./guides/dynamic-capabilities#dynamic-instructions), it stays outside history: compaction never summarizes it or replays it as a message, and an old, finished list can't read as a new request.

Like other state, the list belongs to one session. [Subagents](./subagents) start without it.

`todo__write` returns the full list with per-status `counts`, so channels and hooks can render progress from its `call.settled` output.

## Show the checklist in Slack

`todoSlackRenderer` from `eve/extensions/todo/slack` draws the checklist on the Slack [task card](./channels/slack#task-card). Add it to the Slack channel's `renderers`:

```ts title="agent/channels/slack.ts"
import { slackChannel } from "eve/channels/slack";
import { todoSlackRenderer } from "eve/extensions/todo/slack";

export default slackChannel({
  renderers: [todoSlackRenderer()],
});
```

When a turn calls `todo__write`, its card becomes one Slack `plan` block:

- The latest list's steps come first, one row each. `pending` and `in_progress` keep those Slack statuses, `completed` shows as complete, and a `cancelled` step shows as complete with `(skipped)` after its text.
- The rows eve's default card shows for the turn's [tasks](./tools/tasks) follow the steps, so delegated work stays visible.
- The title counts progress, as in `2 of 4 steps done`, then `Finished 4 steps` once every step is completed or cancelled.

The card updates each time the model rewrites the list. A turn that doesn't call `todo__write` keeps eve's default card, which has no card at all when the turn starts no tasks. A plan block holds at most 50 rows, so with a full checklist, task rows past the 50th are left out.

If you mounted the extension under another file name, pass it as `mount`. For `agent/extensions/checklist.ts`, whose tool is `checklist__write`:

```ts title="agent/channels/slack.ts"
import { slackChannel } from "eve/channels/slack";
import { todoSlackRenderer } from "eve/extensions/todo/slack";

export default slackChannel({
  renderers: [todoSlackRenderer({ mount: "checklist" })],
});
```

`todoSlackRenderer` returns an ordinary Slack renderer, so it composes with your own. Renderers run in the order you list them, and the first is outermost: list yours first to restyle the checklist card, or after it to change eve's default card underneath. See [Customize rendering](./channels/slack#customize-rendering).
