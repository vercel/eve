---
"eve": minor
---

Remote agents now work like local subagents. A remote child inherits the caller's session capabilities, so its tool approvals and `ctx.ask()` questions reach the caller's stream with the call's `taskId`, and you answer them on the caller's session. The child keeps acting as the principal that started it, and the answer is attributed to whoever gave it, which is the responder an approval response policy checks. The same rule now applies to local children.

A send that reaches a remote agent after it answered now runs as its next turn instead of being lost. If a result callback is lost, the caller recovers it at the call's deadline with one read of the new `GET /eve/v1/session/:sessionId/reports/:callId` route. That route returns a result only to a reader that presents, in the `x-eve-callback-token` header, the callback token the result was sent to.

Each result is applied once: children number their answers, so a repeated or late callback can no longer settle the call's next turn. A callback that arrives after the caller's session ended now gets `200` with `{"duplicate":true}` instead of `404`.

A remote child whose question or approval cannot reach the caller now sends it again before waiting for an answer. An answer that can never reach the child fails the call with `AGENT_SESSION_ENDED` or `TASK_UNREACHABLE` instead of leaving it waiting.

Every request to a remote agent now has a 30-second limit and refuses redirects. A remote agent that fails to start, including one whose create request times out, fails the call with `START_FAILED`. A message to a remote agent that fails in a way that may clear, such as a timeout, is sent up to three times with the same `operationId`. A send the agent refused every time fails with `TASK_UNREACHABLE`; one that no attempt confirmed stays queued, and the model is told eve could not confirm it arrived.

Follow-up messages on `POST /eve/v1/session/:sessionId` and `Session.send()` accept an `operationId`. The session admits one message per `operationId` for each principal and remembers its most recent 256, including after it moves to another deployment.

Proxied `approval.candidate` and `approval.settled` events now carry the child's `taskId`. An approval settled when a turn resumes now carries that turn's ID instead of an empty `turnId`.

Upgrading: run the calling agent and every remote agent it calls on releases with the same task protocol version. A deployment reports its version in the `x-eve-task-protocol` header of `GET /eve/v1/health` and in the new `taskProtocol` field of accepted create and message responses. Create, message, and answer requests, and every callback, carry the version. A caller reads the remote's version before it creates a session there, so a call to an older remote fails at once with `START_FAILED` and runs nothing on it. A current remote refuses an older caller, and a current caller refuses a callback from another version, with `409 TASK_PROTOCOL_MISMATCH`.

Sessions from earlier releases are not migrated. A background task that an earlier release left working fails with `STATE_LOST` when the session next runs, and the session continues. Upgrade remote agents and the agents that call them together.
