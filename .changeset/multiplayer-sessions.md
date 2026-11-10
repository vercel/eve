---
"eve": minor
---

Let anyone in a shared session steer the running turn, and guard calls that use the caller's identity after someone else has spoken.

A message from another person now joins the running turn instead of waiting for it to end. The turn keeps its caller, `ctx.session.auth.sender` names who spoke last, and eve tells the model who sent a message when the speaker changes. A message joins even while the turn waits on an approval, sign-in, or question; only the session-limit prompt keeps other people's messages waiting for a turn of their own. Set `turnPolicy: "queue"` to keep a message waiting for the turn to end, except while the turn waits on an approval or sign-in it asked for, which the message joins.

After someone other than the caller speaks, a call that reads a user-scoped token, calls a `forwardPrincipal` connection, or calls a remote agent that forwards the caller needs the caller. Where the session can ask for input, eve asks the caller to approve the call. Where it can't, and in workflow tools, a token or connection call fails with `ConnectionAuthorizationFailedError` and `reason: "confirmation_required"`, and a remote agent call fails with a terminal error that carries the same instruction for the model and isn't a `ConnectionAuthorizationFailedError`. eve retries neither. The caller's next message releases their identity, and a call the caller approves keeps it. Sessions with one person don't change.

A tool that decides from `ctx.session.auth.current` alone, such as a role check, doesn't see who else is steering the turn. Check `ctx.session.auth.sender` as well. eve's own checks do: when someone other than the caller spoke last, the git extension's `gh` tool with app tokens and deployed self-modification call `authorize` for both people and need both to pass, and `openCodeChannel()` returns `unavailable` until the caller speaks again.
