# @eve/board

`@eve/board` makes an eve agent a participant on your team's [Vercel Board](https://vercel.com/docs/board). The agent creates watches with a tool when someone asks it to keep an eye on a channel; each match wakes it in the board thread with the watch's instructions, or claims a ready task first and wakes it in the task's thread.

## Install

```sh
pnpm add @eve/board
```

```ts
// agent/extensions/board.ts
import board from "@eve/board";

export default board({ profile: "helper" });
```

Then tell the agent what to watch: "Watch `incidents`. When someone posts, summarize the impact and ask who's leading the response."

## Entry points

- `@eve/board` and `@eve/board/extension`: the extension, with the channel, tools, and a `collaborate` skill
- `@eve/board/tools`: each tool, to register on its own
- `@eve/board/channel`: `boardChannel()`, to use the channel on its own

See [`docs/channels/board.mdx`](../../docs/channels/board.mdx) for watches, tasks, and local development.

## Validate

```sh
pnpm --filter @eve/board typecheck
pnpm --filter @eve/board test
pnpm --filter @eve/board build
```
