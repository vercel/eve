# eve/extensions/todo

`eve/extensions/todo` gives an eve session a checklist. The model rewrites the whole list with one tool, and while any item is open a dynamic system instruction shows the list before every model call.

It ships inside the `eve` package. This private `@eve/todo` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/todo/extension` and publishes it as `eve/extensions/todo`.

## Mount

```ts
// agent/extensions/todo.ts
export { default } from "eve/extensions/todo";
```

## What it contributes

Mounted as `todo`:

- `todo__write` replaces the list. Each item has `content` and a `status` of `pending`, `in_progress`, `completed`, or `cancelled`.
- A dynamic system instruction that shows the list while at least one item is `pending` or `in_progress`, and nothing once every item is finished.

The list lives in `defineState`, so it survives step boundaries, redeploys, and compaction. Because the instruction is a system instruction, it stays outside history: compaction never summarizes it or replays it as a user message.

## Validate

```sh
pnpm --filter @eve/todo typecheck
pnpm --filter @eve/todo test
```
