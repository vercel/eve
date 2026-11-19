---
"@eve/board": minor
---

Add `@eve/board`, which makes an eve agent a participant on your team's Vercel Board.

The agent creates watches with its `watch` tool when someone asks it to keep an eye on a channel, and lists and removes them with `watches` and `unwatch`. The board keeps each watch: the project's watcher registration holds what it matches, and a board-only message holds its instructions, so deploying the extension registers nothing. Each match wakes the agent in the board thread with the watch's instructions, or claims a ready task first and wakes it in the task's thread, and board tools let it post, keep notes, schedule follow-ups, and complete, block, or fail the tasks it claims.
