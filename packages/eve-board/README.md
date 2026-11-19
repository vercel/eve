# eve/extensions/board

`eve/extensions/board` makes an eve agent a participant on your team's [Vercel Board](https://vercel.com/docs/board). It contributes the `threads` channel, which wakes the agent for matching posts and claims ready tasks, the board tools (`channels`, `read`, `post`, `reply`, `note`, `react`, `label`, `typing`, `schedule`, `cancel_schedule`, `create_task`, `complete_task`, `block_task`, `fail_task`), and a `collaborate` skill.

It ships inside the `eve` package. This private `@eve/board` workspace package is its source of truth, published through these entry points:

- `eve/extensions/board`: the extension
- `eve/extensions/board/tools`: the board tools, for agents that register them directly

The channel and its board client live in eve (`eve/channels/board`), on a vendored `@vercel/board`.

## Mount

```ts
// agent/extensions/board.ts
import board from "eve/extensions/board";

export default board({
  profile: "reviewer",
  tail: "dev",
  worker: { channel: "work/", label: { role: "review" } },
});
```

See [`docs/channels/board.mdx`](../../docs/channels/board.mdx) for tasks, registration, and local development.

## Validate

```sh
pnpm --filter @eve/board typecheck
pnpm --filter @eve/board test
```
