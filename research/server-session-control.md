---
issue: https://github.com/vercel/eve/issues/6568
status: in-progress
last_updated: "2026-11-23"
---

# Server session control and deleted-anchor retirement

## Summary

Server-side code running inside an eve deployment — schedules (`defineSchedule`), webhooks, background jobs, and custom server routes — has no way to retire or prewarm a session by ID without calling back into the deployment's own HTTP routes. At the same time, a handed-off session on Vercel whose initial anchor deployment has been deleted cannot retire cleanly through `end()` or its session timeout because finalization fails trying to write to the deleted anchor's stream and resume its anchor hook.

This plan addresses both gaps (tracking [#6568](https://github.com/vercel/eve/issues/6568) and [#4603](https://github.com/vercel/eve/issues/4603)):

1. Add `sessions.end(sessionId, options?)` and `sessions.prewarm(sessionId)` to `eve/server` while keeping `sessions.attach(sessionId)` read-only.
2. Retire handed-off sessions cleanly on `end()` and `timeout` when the anchor deployment has been deleted, preserving live cleanup (sandbox teardown and child session termination) on the active deployment and cancelling the dead anchor run.

## Public API (`eve/server`)

`eve/server` exports `sessions`, `SessionEndOptions`, and `PrewarmSessionResult`:

```ts
import { sessions, type PrewarmSessionResult, type SessionEndOptions } from "eve/server";

const delivery = await sessions.end(sessionId, {
  auth: appAuth,
  reason: "scheduled cleanup",
});

const prewarmed: PrewarmSessionResult = await sessions.prewarm(sessionId);
```

- `sessions.attach(sessionId): SessionReader` stays read-only (`id` and `stream()`).
- `sessions.end(sessionId, options?)` accepts `SessionEndOptions` (`{ readonly auth?: SessionAuthContext | null; readonly reason?: string }`), dispatches the same `reset` control command as `Session.end()`, waits for inbox hooks to release, and returns a `Delivery` over recorded history (`follow: false`). It throws `SessionNotActiveError` when the session is not active. When the session's owner deployment was deleted or retired, it falls through to stranded-session retirement (`endStrandedSession`).
- `sessions.prewarm(sessionId)` prepares an idle session to hand off onto the current deployment without starting a model turn, resolving the target deployment ID from `VERCEL_DEPLOYMENT_ID` (or the Workflow world when `deploymentAffinity` is enabled) and returning `Promise<PrewarmSessionResult>` (`ready`, `accepted`, `unsupported`, or `no_active_session`).

Like `sessions.attach()`, `sessions.end()` and `sessions.prewarm()` run in process without channel auth; callers must authorize any session ID obtained from an external request.

## Deleted-anchor retirement semantics

When a session started on deployment A (anchor run `S`) and handed off to deployment B (live owner run `O`), deleting deployment A leaves `O` alive while `S`'s encryption key returns `RunKeyFetchError` (HTTP 404, `"Deployment not found."`).

```text
end() / timeout -> owner run O (deployment B, live)
  1. inbox.dispose()              -> releases inbox and channel address hooks
  2. terminateChildSessionsStep() -> terminates live children on deployment B
  3. endSessionSandboxStep()      -> cleans up sandbox on deployment B
  4. publishTerminalSessionEvent  -> checks anchor run key before stream I/O;
                                     on deleted deployment 404, logs warn and
                                     returns without writing or firing channel
                                     session.ended handlers
  5. signalSessionAnchorStep      -> resumes `${S}:anchor`; on deleted
                                     deployment 404 (or sealed-box key check),
                                     cancels anchor run S, logs warn, returns
```

### Invariants

- Only the exact Vercel deleted-deployment 404 (`RunKeyFetchError` with status `404` and `"Deployment not found"`) is treated as a retired anchor. Other 404s (such as `"Project not found."`) and transient errors continue to fail as before.
- The anchor key check runs before opening `sessionWritable` in `publishTerminalSessionEvent`, preventing `@workflow/core` from queuing background stream flush ops that would fail the step after return and preventing channel `session.ended` handlers from running for an unrecorded terminal event.
- `signalSessionAnchorStep` accepts an optional `sessionId` and falls back to stripping `:anchor` from `token`, preserving replay compatibility for in-flight workflows started on earlier code.
- `resumeSessionInbox` verifies the owner run's deployment key on known-session `reset` commands so sealed-box hooks whose owner deployment was deleted still trigger stranded-session retirement instead of waiting for hook release until timeout.
