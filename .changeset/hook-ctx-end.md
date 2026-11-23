---
"eve": minor
---

Add `ctx.end()` to hook handlers so hooks can permanently retire a session from any event.

`ctx.end(reason?)` is available on `HookBaseContext` for every hook event. On `turn.settled`, `delivery.settled`, or between turns, the remaining handlers for the event finish, and then eve tears down child sessions and the sandbox (`onSessionEnd` with `reason: "completed"`), records `session.ended` with `outcome: "completed"` and `cause: { hook }`, closes the stream, and releases channel addresses. When called during a running or opening turn, eve stops the turn before its next model call (`turn.settled` with `outcome: "cancelled"`), cancels working tasks, and then ends the session with `outcome: "completed"` and `cause: { hook }`. `ctx.end()` drops any pending `ctx.continue()` continuation on the same turn, acts once with the first hook winning, does nothing on `session.ended`, and throws if called after the handler resolves.
