---
"eve": patch
---

Add `eve/extensions/todo`, a built-in extension that gives a session a checklist the model keeps current and sees before every model call while work is open.

It brings back the `todo` tool removed in 0.65.0 as an opt-in mount: `export { default } from "eve/extensions/todo"` in `agent/extensions/todo.ts` adds `todo__write`. The list is shown as a dynamic system instruction instead of being re-injected into history after compaction, so a finished list can no longer read as a new request.

Add `todoSlackRenderer()` from `eve/extensions/todo/slack` to a Slack channel's `renderers` to show the checklist on the task card as a native plan.
