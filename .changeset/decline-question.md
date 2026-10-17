---
"eve": minor
---

A person can decline a question instead of answering it: send `{ requestId, decline: true }` in `inputResponses`. The session reports `input.resolved` with `outcome: "declined"`, `ctx.ask()` resolves as `{ status: "declined" }`, and `ask_question` returns `{ status: "declined" }`, which tells the model to continue without the answer and not to ask again.

A decline aimed at any other kind of request (a tool approval, a session-limit prompt) is rejected with a message, and that request stays open for a valid answer.

A person who can send to a session can also decline a pending sign-in with `session.declineSignIn(attemptId)`, or `{ authorizationDecline: { attemptId } }` over HTTP. This covers inline sign-ins, an approval responder's sign-in, and sign-ins relayed from workflow tools or subagents; each is settled by the session or run that owns it. The session reports `authorization.completed` with `outcome: "declined"`, preserves other pending sign-ins, fails the call that waited for the declined sign-in with `The user declined to sign in.`, and resumes the held turn with instructions to continue without signing in and not ask again unless requested. A decline naming a sign-in that is no longer pending is ignored. A decline cannot be combined with a message.
