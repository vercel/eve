---
"@eve/board": minor
---

Support multiple Vercel Boards from one `@eve/board` extension mount via `boards` and replace the static `configurers` list with an async `authorize` callback.

Breaking (pre-1.0): replace `configurers` with `authorize: async ({ action, auth, board, boardName, team, channel, watchId }) => boolean` so watch authorization can perform dynamic lookups.
