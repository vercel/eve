---
"eve": major
---

Another person's message in a shared session now joins the running turn instead of waiting for a turn of its own, and eve asks the turn's caller before a call uses their identity after someone else has spoken.

The turn keeps its caller as `ctx.session.auth.current`, and `ctx.session.auth.sender` names who sent the latest message it read. eve tells the model who sent a message when the speaker changes. Set `turnPolicy: "queue"` to keep a message waiting for the turn to end. Memory saves a turn only when the slot's scope belongs to everyone who spoke in it. Sessions with one person don't change.

A message no longer withdraws an open approval or sign-in, even with `turnPolicy: "queue"`. Each waiting call becomes a task: the model reads a `[Tasks]` note, receives the call's result in a `task.result` message once the person answers, and can drop the call with `eve__task_cancel`. The request stays `open` on the stream, so clients that cleared a card when the next message arrived should keep it until `interaction.settled`.

After someone other than the caller speaks, a call that reads the caller's user-scoped token, calls a `forwardPrincipal` connection, creates a dynamic schedule, or starts an MCP event watch opens an approval that only the caller can approve. The prompt quotes the other person's latest message. The caller's approval also covers their later calls until anyone else speaks. Where eve can't ask, the call fails with `ConnectionAuthorizationFailedError` and `reason: "confirmation_required"`.

New APIs: `steered()` from `eve/tools/approval` applies the same approval to any call made after someone else spoke. `ctx.getToken(provider, { as })` and `ctx.requireAuth(provider, { as })` read the token of another person who has spoken, and the result's `principal` names whose token it is. `samePrincipal(a, b)` from `eve/context` compares two people the way eve does. With user tokens, the git extension's `gh` tool takes an `actor` input.

To migrate, review code that authorizes from `ctx.session.auth.current` alone, such as a tool's role check, a credential your code picks like an app token or tenant API key, a dynamic tool, subagent, or connection, or `ctx.to()` auth. That access now reaches anyone who steers the turn. Set `approval: steered()` in `agent.ts`, or also check `ctx.session.auth.sender`. A remote agent that forwards the caller fails with a terminal error after someone else speaks, unless `steered()` asks the caller first. See [Shared sessions](https://eve.dev/docs/concepts/security-model#shared-sessions).

Thanks @pcomans for proposing that a sign-in stay open when its caller steers past it, in the review of #6199.
