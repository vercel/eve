---
issue: "None"
status: implemented
last_updated: "2026-09-23"
---

# Client subagent streams

## Problem

A parent stream announces each delegation with `subagent.called`, but the
child's progress lives on the child's own stream. For a remote child, eve
already serves a parent-origin proxy at `childStreamPath`: the parent checks
that the child belongs to the session, resolves the remote agent's authored
`auth` and `headers`, and relays the child's stream. No public client API reads
that path. Frontends that want live remote activity must reimplement NDJSON
parsing, stream-version normalization, lease control, and cursor reconnection,
all of which are internal to `eve/client`. The dev TUI does exactly this with
private helpers.

## API

```ts
const session = client.sessions.attach(parentSessionId);

for await (const event of session.streamSubagent(called, options)) {
  if (isCurrentTurnBoundaryEvent(event)) break;
}
```

`streamSubagent(called: SubagentCalledStreamEvent, options?: StreamOptions)`
returns the child's events as an async iterable. `EveEvalSession` exposes the
same method so evals can follow children with the eval client's credentials.

## Semantics

- The event must come from the same session (`called.data.sessionId`).
  Otherwise the call throws before any request.
- The client reads `called.data.childStreamPath` with the session's host,
  credentials, and redirect policy. A local child's path is its own session
  stream route. A remote child's path is the parent-origin proxy.
- The child cursor is independent: it starts at `0`, honors `startIndex`,
  `follow: false`, `signal`, and `streamReconnectPolicy` exactly as
  `stream()` does, and never advances the parent's `streamIndex`.
- A child parks after answering and may be continued. The iterator follows the
  stream like `stream()`; callers stop at a turn boundary.

## Authorization boundary

The client never learns the remote URL or credentials. Access is decided by the
parent deployment: its channel authenticates the proxy route with the same
`auth` as the parent session, and the route refuses coordinates that do not
match a `subagent.called` event recorded on that parent. Applications that
authorize session access per user must authorize the parent session on the
proxy route. A local child's stream route keeps the channel's usual session
authorization.

## Implementation

`followStreamIterable` takes a stream route path instead of a session ID, so
session streams and child streams share one reconnecting reader.

## Alternatives

- **A React hook, or automatic child following in `useEveAgent`.** Deferred.
  Applications choose which children to follow and how to render them; the
  session method plus `defaultMessageReducer` covers that without a new hook.
- **Exporting the NDJSON reader and stream-version helpers.** Rejected. It
  would make the wire format public API and leave cursor and lease handling to
  every caller.
