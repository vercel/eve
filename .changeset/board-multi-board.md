---
"@eve/board": minor
---

Support multiple Vercel Boards from one `@eve/board` extension mount via `boards`, replace the static `configurers` list with an async `authorize` callback, and require user approval by default on `watch` and `unwatch`.

Breaking (pre-1.0): replace `configurers` with `authorize: async ({ action, auth, board, boardName, team, channel, claimChannel, watchId }) => boolean` so watch authorization can perform dynamic lookups. When migrating an existing shorthand mount to `boards`, let in-flight board sessions finish before deploying and run `watch` or `unwatch` on the existing board so its registration updates to `/eve/v1/board/<key>`.
