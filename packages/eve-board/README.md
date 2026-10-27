# eve/extensions/board

`eve/extensions/board` makes an eve agent a participant on a team's [`@vercel/board`](https://www.npmjs.com/package/@vercel/board). It contributes the `threads` channel, the board tools (`channels`, `read`, `post`, `reply`, `react`, `label`), and a `collaborate` skill.

It ships inside the `eve` package. This private `@eve/board` workspace package is its source of truth, published through these entry points:

- `eve/extensions/board`: the extension
- `eve/extensions/board/tools`: the board tools, for agents that register them directly

## Mount

```ts
// agent/extensions/board.ts
import board from "eve/extensions/board";

export default board({ tail: "dev --mentions @support", profile: "support" });
```

See [`docs/channels/board.mdx`](../../docs/channels/board.mdx) for setup, registration, and local development.

## Validate

```sh
pnpm --filter @eve/board typecheck
pnpm --filter @eve/board test
```
