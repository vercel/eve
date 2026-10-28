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

The list holds at most 50 items of up to 500 characters each. It lives in [state](./concepts/state), so it survives step boundaries, redeploys, and [compaction](./concepts/default-harness#compaction). Because the list is a [dynamic system instruction](./guides/dynamic-capabilities#dynamic-instructions), it stays outside history: compaction never summarizes it or replays it as a message, and an old, finished list can't read as a new request.

Like other state, the list belongs to one session. [Subagents](./subagents) start without it.

`todo__write` returns the full list with per-status `counts`, so channels and hooks can render progress from its `call.settled` output.
