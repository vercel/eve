---
issue: https://github.com/vercel/eve/issues/216
last_updated: "2026-06-23"
status: proposed
---

# Channel session reset and scoped cancellation

## Summary

Telegram private chats and Twilio conversations reuse a stable continuation identity, so one durable
session can accumulate history and state forever. eve should recognize `/new` on those channels and
terminate the current session before the identity is reused.

Cancellation has two explicit scopes:

- **turn:** stop the active turn and its descendants; keep the entry session resumable;
- **session:** stop the entry session and its complete execution tree; the next message starts with
  empty history and authored state.

Slash commands are one consumer of a general cancellation API. The same semantics must be available
to the eve HTTP channel, TypeScript client, custom channels, higher-level channel handlers, session
callbacks, and evals.

## Authoring API

### eve HTTP channel

Expose one authenticated route:

`POST /eve/v1/session/:sessionId/cancel`

The body is a strict union with no default scope:

```json
{ "scope": "turn", "cancelToken": "<active-turn capability>" }
```

```json
{ "scope": "session", "continuationToken": "<current session capability>" }
```

The route authenticates first, then verifies that the capability belongs to `:sessionId`. Invalid
bodies return `400`; stale or mismatched capabilities return a non-disclosing `409`; accepted
cancellation returns `202`.

Every request that starts a turn returns a fresh `cancelToken` alongside `sessionId` and the current
`continuationToken`. A cancel token is valid only for that active turn. It cannot cancel the entry
session or a later turn.

### TypeScript client

- `MessageResponse.cancel()` cancels the turn represented by that response.
- `ClientSession.cancel()` cancels the current entry session.
- Both use the client's normal auth, headers, redirects, and error handling.
- Session cancellation clears the client's resumable cursor so a later send cannot accidentally
  target the cancelled entry.
- Aborting a request or stream with `AbortSignal` remains local transport cancellation; it does not
  request server-side cancellation.

### Channel authors

Custom `defineChannel` route handlers receive separate operations to:

- cancel a turn using its session id and turn cancel token;
- cancel a session using its channel-local continuation token;
- restart a session with replacement input after the old session releases its identity.

The operations own token namespacing and ordering. Authors do not call workflow APIs or manually
compose “cancel, then hope delivery starts fresh.”

Higher-level channel handlers can return a `reset-session` decision with auth, optional context, and
optional replacement content. This lets a Slack mention or direct-message handler request the same
behavior without receiving low-level route operations.

In-session callbacks and event subscribers use an explicit cancellation operation with a required
`turn` or `session` scope. Requesting cancellation exits normal authored execution; code after the
request must not continue.

### Evals

Evals expose first-class controls for cancelling an active turn and its entry session. An eval can
retain a cancellable handle while work is active, request cancellation, and continue observing the
resulting event boundary. Expected cancellation is assertable behavior, not an automatic eval
failure.

Eval cancellation uses the TypeScript client and public channel APIs. It must work for sessions
created by custom channels as well as the built-in eve channel.

## Semantics

### Turn cancellation

The cancel token is minted per turn and bound to `(sessionId, turnId)`.

```text
 TypeScript client       eve channel       runtime control plane       session S1
        |                     |                     |                       |
 send() |-------------------->| start/resume S1     |                       |
        |                     |-------------------->| dispatch turn T7 ---->| T7
        |<--------------------| S1, continuation C1 |                       |-- model
        |                     | cancel token K7     |                       |-- tools
        |                     |                     |                       `-- delegates
        |                     |                     |                       |
 MessageResponse.cancel()    |                     |                       |
        | POST /session/S1/cancel                   |                       |
        | { scope: turn, cancelToken: K7 }           |                       |
        |-------------------->|-------------------->| validate K7=(S1,T7)   |
        |                     |                     | cancel T7 subtree ---->|
        |<--------------------| 202 accepted        |<------ T7 settles ----|
        |                     |                     | retire K7              |
        |                     |                     | S1 -> waiting          |
        |                     |                     | C1 remains active      |
```

When T7 completes, fails, or is cancelled, K7 becomes stale. The next turn receives a new token K8.
K7 can never cancel K8 or session S1.

### Session cancellation

Session cancellation binds the current continuation token to the session id in the request. The
runtime releases the continuation before tearing down the tree; that release is the reset
linearization point.

```text
 Client or /new       channel layer       runtime control plane        session S1
      |                    |                       |                        |
      | cancel (S1, C1)    |                       |                        |
      |------------------->|---------------------->| validate C1 owns S1   |
      |                    |                       | S1 -> closing          |
      |                    |                       | release C1 from S1     |
      |                    |                       | ==================     |
      |                    |                       | reset linearizes       |
      |                    |                       | cancel complete tree ->| S1
      |<-------------------| 202 accepted          |                        `-- active turn
      |                    |                       |                            `-- descendants
      |                    |                       |<------ tree settles ----|
      |                    |                       | S1 -> session.cancelled |

 Stable channel identity uses continuation C1 again:

      before reset   C1 -> S1
      after release  C1 -> no active session
      next message   C1 -> new session S2 with empty history and state

 Cleanup remains bound to S1. An old request naming S1 cannot cancel S2 even though S2 reuses C1.
```

For bare `/new`, the flow ends after S1 is cancelled. For `/new <message>` or `/new` with an
attachment, restart waits for the release barrier and creates S2 with that replacement content.

### Runtime guarantees

- Cancellation follows ownership from entry session → turn → tools and delegated agents, including
  remote descendants.
- A cancelling session cannot accept input, launch work, or reclaim its continuation.
- Cooperative abort reaches models, tools, sandboxes, and delegates; the runtime remains responsible
  for terminating work that does not cooperate.
- Late descendant results cannot resume a cancelled ancestor or mutate a replacement session.
- Turn cancellation ends at `session.waiting`; session cancellation ends at `session.cancelled`.
- Cancellation is intentional control flow and does not trigger generic user-facing failure output.
- Completed external side effects remain recorded and are not rolled back.

## `/new` behavior

Telegram and Twilio expose:

```ts
resetCommands?: false | readonly string[];
```

- omitted: `['new']`;
- `false`: disabled;
- array: replace the default names.

Inbound handling verifies the provider request and runs authored gating/auth before matching the
command. A `null` authored result drops the input without cancellation.

- Bare `/new` silently cancels the session and creates no empty workflow.
- `/new <message>` starts a fresh session with the stripped message.
- Telegram attachments on `/new` belong to the fresh session.
- `/new@botname` matches only the configured Telegram bot.
- Prefixes such as `/newspaper`, unknown commands, and disabled commands remain normal model input.
- The command itself is never added to history and successful reset sends no confirmation.
- Slack has no default reset command; authors opt in through their inbound handler.

## Delivery and verification

Implementation must cover the HTTP contract, cancellation outcomes and events, ownership-tree
propagation, TypeScript client, eval driver, custom-channel operations, Telegram and Twilio `/new`,
docs, and a patch changeset.

Add a new `e2e/fixtures/agent-cancellation` fixture. Its custom `defineChannel` must use only public
channel APIs—no runtime/workflow imports and no proxy through the built-in eve cancellation route.
The fixture includes independent evals for:

- **turn cancellation:** cancel active work, observe the turn boundary and `session.waiting`, then
  prove a follow-up resumes the same session and context;
- **session cancellation:** cancel active work, observe `session.cancelled`, reuse the same channel
  identity, then prove the new session id, history, and authored state are fresh.

The evals use the new eval cancellation controls, assert events and identities directly, work
locally and against deployed targets, and require no external service beyond model credentials.

Also cover malformed/scoped HTTP requests, auth before capability inspection, stale tokens, command
parsing, attachments, duplicate cancellation, delivery/completion races, nested local and remote
delegates, client cursor updates, and the distinction between `AbortSignal` and server cancellation.

Run the repository's required unit, integration, scenario, typecheck, lint, format, invariant, docs,
and build checks, plus:

```sh
cd e2e/fixtures/agent-cancellation
pnpm exec eve eval --strict
```
