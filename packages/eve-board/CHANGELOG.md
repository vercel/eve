# @eve/board

## 0.2.1

Released 2026-11-28 · [Compare with 0.2.0](https://github.com/vercel/eve/compare/%40eve%2Fboard%400.2.0...%40eve%2Fboard%400.2.1)

### Bug Fixes

- Fail config validation with a migration message when an `@eve/board` mount still sets the removed `configurers` option instead of silently ignoring it. ([#6862](https://github.com/vercel/eve/pull/6862))
- Fix `watch` and `unwatch` failing with `client_id_taken` after an `@eve/board` mount's `watchChannel` changes, by reusing the agent's existing watch lock wherever it lives. ([#6852](https://github.com/vercel/eve/pull/6852))

### Dependencies

- Updated eve to 1.6.0.

## 0.2.0

Released 2026-11-25 · [Compare with 0.1.0](https://github.com/vercel/eve/compare/%40eve%2Fboard%400.1.0...%40eve%2Fboard%400.2.0)

### Features

- Support multiple Vercel Boards from one `@eve/board` extension mount via `boards`, replace the static `configurers` list with an async `authorize` callback, and require user approval by default on `watch` and `unwatch`.
  Breaking (pre-1.0): replace `configurers` with `authorize: async ({ action, auth, board, boardName, team, channel, claimChannel, watchId }) => boolean` so watch authorization can perform dynamic lookups. When migrating an existing shorthand mount to `boards`, let in-flight board sessions finish before deploying and run `watch` or `unwatch` on the existing board so its registration updates to `/eve/v1/board/<key>`. ([#6845](https://github.com/vercel/eve/pull/6845))
- Export `publicRoutePath` from `eve/channels`, reserve eve's own `/eve/v1/` protocol namespaces at compile time, warn on unreachable channel routes in Vercel service builds, and move `@eve/board`'s default wake route to `POST /eve/v1/board/wake` with a `route` option.
  `@eve/board` continues serving `POST /board/wake` for one release so existing 0.1.0 standalone registrations keep waking until their next watch update rewrites the registration path. ([#6844](https://github.com/vercel/eve/pull/6844))

### Dependencies

- Updated eve to 1.5.0.

## 0.1.0

Released 2026-11-20 · [View commits](https://github.com/vercel/eve/commits/%40eve%2Fboard%400.1.0)

### Features

- Add `@eve/board`, which makes an eve agent a participant on your team's Vercel Board.
  The agent creates watches with its `watch` tool when someone asks it to keep an eye on a channel, and lists and removes them with `watches` and `unwatch`. The board keeps each watch: the project's watcher registration holds what it matches, and a board-only message holds its instructions, so deploying the extension registers nothing. Each match wakes the agent in the board thread with the watch's instructions, or claims a ready task first and wakes it in the task's thread, and board tools let it post, keep notes, schedule follow-ups, and complete, block, or fail the tasks it claims. ([#5477](https://github.com/vercel/eve/pull/5477))

### Dependencies

- Updated eve to 1.2.0.
