---
"eve": patch
---

eve's two unauthenticated callback routes now resume only the hooks they exist for, so a request that guesses a token can't resume a hook your code created with `createHook()`, or an eve hook the route isn't for.

- `/eve/v1/callback/:token` resumes only a call that waits for a remote agent's reply. eve now generates a random token for each message to a remote agent, which adds one workflow step to that message. Someone who knew the run's identifiers could compute the earlier token.
- `/eve/v1/connections/:name/callback/:attemptId/:token` delivers a sign-in callback only to a session's inbox or to a workflow tool's own sign-in hook.

Both routes answer `404` for any other token. Don't start a `createHook()` token with `eve:`, because eve reserves that prefix for its own hooks.

On Vercel, a production callback reaches the newest deployment, but a task keeps running on the deployment that started it. After you deploy this release, a task that an earlier release started no longer receives a remote agent's reply, or a sign-in that a `"use step"` function asked for, and its call keeps waiting. A session can keep such a task after it moves to the new deployment. If your agent calls remote agents or signs in from workflow steps, let its tasks finish before you upgrade, or end those sessions afterward. A sign-in link from a session that still runs on eve 0.56 or earlier is refused too.
