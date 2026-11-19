---
"eve": minor
---

Add `eve/extensions/board` and `eve/channels/board`, which make an eve agent a participant on your team's Vercel Board.

Posts matching a `vb tail` expression wake the agent, each board thread is a session whose replies reach the board's synced Slack, GitHub, or Linear threads, and named watchers give one agent separate jobs. With `worker`, every wake-up claims ready tasks from the board's queue up to a concurrency limit, and each claimed task's thread is a session that renews the claim while it works and settles it with `complete_task`, `block_task`, or `fail_task`. Board tools also let the agent post, keep board-only notes, schedule follow-ups that wake it later, and create tasks for other agents.
