---
issue: https://github.com/vercel/eve/issues/216
last_updated: "2026-06-23"
status: proposed
---

# Channel session reset and scoped cancellation

## Summary

Telegram private chats and Twilio conversations derive a stable continuation identity from the
chat or phone-number pair. That is the right default for normal conversation continuity, but it
means one durable session can accumulate history and state forever.

eve should give users an explicit clean-session boundary. Telegram and Twilio will recognize
`/new` by default. The command will terminate the current session and all work owned by it, release
the channel identity, and let the next message start a new session with empty history and state.

This feature also establishes a general cancellation architecture. Turn cancellation and session
cancellation share one control plane, but have different terminal behavior:

- turn cancellation stops only the active turn tree and leaves its entry session resumable;
- session cancellation stops the entire session tree and permanently terminates its entry session.

The same behavior must be available through the eve HTTP channel, custom `defineChannel` routes,
higher-level channel handlers such as Slack mentions, and in-session event subscribers. Slash
command parsing is only one caller of the cancellation architecture.

## Product decisions

- `/new` is the only reset command enabled by default.
- The default applies to Telegram messages and Twilio text or literal voice-transcription input.
- A bare `/new` silently cancels the current session and does not create an empty replacement.
- `/new <message>` cancels the current session, then sends `<message>` as the first turn of a fresh
  session.
- Telegram attachments accompanying `/new` are content for the fresh session, even when there is no
  trailing text.
- Successful reset does not send a confirmation or render cancellation as an agent error.
- Channel authors can disable reset commands or replace the default command list.
- Slack does not enable a reset command by default. Authors can opt in from their mention or direct
  message handler.
- Existing workflow records and event streams remain available for inspection. Reset is not data
  deletion.
- External side effects that completed before cancellation cannot be rolled back.

## Cancellation model

### Scope

Every cancellation request has an explicit scope. There is no inferred or default scope at public
API boundaries.

**Turn scope**

- Targets one active turn within a session.
- Stops model generation, tools, and delegated local or remote work owned by that turn.
- Ends the turn with an intentional cancellation outcome.
- Returns the parent session to its waiting state with history and authored state preserved.
- A later message resumes the same entry session.

**Session scope**

- Targets the entry session identified by its current continuation capability.
- Immediately prevents the entry from accepting more input or starting more work.
- Stops the active turn and every active descendant owned by the session.
- Ends the entry with an intentional `session.cancelled` terminal outcome.
- Releases the continuation identity so a later message using the same channel identity starts a new
  entry session.

The distinction is semantic, not just a difference in which workflow run receives an abort signal.
A session reset is complete only when the old entry can no longer resume and its execution tree is
being torn down as one unit.

### Ownership tree

Cancellation follows execution ownership. An entry session owns its active turn; a turn owns every
tool or delegated agent it starts; delegated agents own their descendants. Local and remote work use
the same logical tree even when they run in different processes or deployments.

The runtime must know the parent-child relationship for every cancellable operation. When a node is
cancelled, cancellation propagates to all active descendants. Work discovered while an ancestor is
already cancelling is cancelled immediately rather than allowed to escape the tree.

### Cooperative and enforced cancellation

The runtime first propagates a cooperative cancellation signal through model calls, authored tools,
sandbox operations, and delegated-agent requests. Well-behaved work can then stop cleanly and report
its cancellation outcome.

Cooperation cannot be the correctness boundary. The durable runtime remains responsible for
terminating work that does not observe the signal and for ensuring a cancelled parent cannot resume
after a descendant settles. No active branch may outlive the session indefinitely or append a late
assistant message after reset.

### Terminal state

Cancellation is intentional control flow, not failure:

- turn scope produces a cancelled turn boundary followed by a waiting session;
- session scope produces a terminal `session.cancelled` boundary and closes the old stream;
- neither scope produces a generic user-facing error message;
- callbacks, clients, hooks, and instrumentation can distinguish cancelled, completed, and failed
  sessions.

## Architecture diagrams

### Turn cancellation: the session survives

The server mints a new cancel token for each turn. The token is bound to both the session and that
specific active turn; it is not authority over the entry session.

In the diagrams, `S1` is a session id, `T7` is a turn id, `C1` is a continuation token, `K7` is a
turn cancel token, and `R` is the stable raw identity derived by Telegram or Twilio.

```text
 TypeScript client      eve channel/API       runtime control plane       S1 execution tree
        |                      |                        |                         |
 send() |  POST message       |                        |                         |
        |--------------------->|  start/resume S1       |                         |
        |                      |----------------------->|-- dispatch T7 --------->| S1 entry
        |                      |                        |                         `-- T7
        |                      |                        |                             |-- model
        |                      |                        |                             |-- tools
        |                      |                        |                             `-- delegates
        |<---------------------|  sessionId: S1         |                         |
        |                      |  continuation: C1      |                         |
        |                      |  cancelToken: K7       |                         |
        |                      |                        |                         |
 MessageResponse stores K7    |                        |                         |
        |                      |                        |                         |
 cancel()                     |                        |                         |
        |  POST /session/S1/cancel                     |                         |
        |  { scope: "turn", cancelToken: K7 }          |                         |
        |--------------------->|-- authenticate         |                         |
        |                      |-- forward (S1, K7) --->|                         |
        |                      |                        |-- resolve K7 = (S1,T7)  |
        |                      |                        |-- verify URL session S1 |
        |                      |                        |-- cancel T7 subtree ---->|
        |<---------------------|  202 accepted          |                         |
        |                      |                        |<-- T7 settled -----------|
        |                      |                        |-- retire K7              |
        |                      |                        |-- S1 -> session.waiting  |
        |                      |                        |   continuation C1 stays  |
```

Token lifecycle:

```text
 turn T7 starts       K7 valid only for (S1, T7)
 turn T7 ends         K7 becomes stale, whether T7 completed, failed, or was cancelled
 next turn T8 starts  server returns a new K8; K7 can never cancel T8

 continuation C1 remains bound to entry session S1 throughout
```

This gives the active `MessageResponse` exactly enough authority to stop its own turn. A leaked or
delayed K7 cannot terminate S1 and cannot affect a later turn.

### Session cancellation: the entry session terminates

Session cancellation uses the current continuation capability and the session id together. The
runtime first closes the old entry's input path, then tears down the complete ownership tree.

```text
 Client or /new       channel layer        cancellation coordinator        session tree
      |                    |                          |                          |
      | cancel session S1  |                          |                          |
      | continuation C1    |                          |                          |
      |------------------->|  authenticate + bind     |                          |
      |                    |  request to (S1, C1)     |                          |
      |                    |------------------------->|                          |
      |                    |                          |  S1: active -> closing   |
      |                    |                          |                          |
      |                    |                          |  release C1 from S1      |
      |                    |                          |  ===================     |
      |                    |                          |  reset linearizes here   |
      |                    |                          |                          |
      |                    |                          |-- cancel S1 tree ------->| S1 entry
      |                    |                          |                          `-- active turn
      |                    |                          |                              |-- model/tool
      |                    |                          |                              `-- delegates
      |<-------------------|  accepted                |                          |
      |                    |                          |<-- all branches settle --|
      |                    |                          |  S1: cancelled           |
      |                    |                          |  stream: session.cancelled
```

The same channel identity can then start over:

```text
 stable Telegram/Twilio identity R
                 |
                 `-- channel continuation C1
                              |
            before reset:  C1 -> session S1 (cancelled and permanently closed)
            after reset:   C1 -> no active session
            next message:  C1 -> new session S2 (empty history and authored state)

 Old cleanup is bound to S1. Even though S2 reuses C1, an old request naming S1 cannot cancel S2.
```

For bare `/new`, the flow stops after S1 is cancelled. For `/new <message>` or `/new` with an
attachment, restart waits for the release barrier and then creates S2 with the replacement content.

## Architecture by layer

### 1. Public cancellation contract

The eve channel exposes one route:

`POST /eve/v1/session/:sessionId/cancel`

Its body is a strict scoped union:

```json
{ "scope": "turn", "cancelToken": "<active-turn capability>" }
```

or:

```json
{ "scope": "session", "continuationToken": "<current session capability>" }
```

The two capabilities have intentionally different lifetimes:

- a cancel token authorizes cancellation of one active turn;
- a continuation token authorizes control of the current entry session and is the capability needed
  to reset it.

Every create-session or follow-up response that starts a turn returns that turn's cancel token. The
token rotates for each turn and is never reused as session authority. The continuation token remains
the session capability returned and tracked by the existing continuation flow.

The route authenticates the caller before inspecting either capability. It verifies that the
capability belongs to the session id in the URL and rejects missing, stale, crossed, or mismatched
capabilities without revealing another session's state.

The route returns `202` once cancellation has been durably accepted and the target can no longer
accept new work. A caller can observe the final cancellation boundary on the session stream. Invalid
request shapes return `400`; a capability that does not identify an active target returns a
non-disclosing `409`.

### 2. TypeScript client and eval control

The TypeScript client exposes first-class operations for both cancellation scopes. An active
`MessageResponse` carries the capability needed to cancel that turn, while `ClientSession` can
cancel its current entry session. Both operations call the scoped eve cancellation route and reuse
the client's normal authentication, headers, redirects, and error handling.

After session cancellation, the client must not retain a cursor that can accidentally resume the
cancelled entry. The next send on that client session either starts fresh or requires an explicit
new session handle, according to the existing client state model. A stale or already-terminal target
is reported distinctly from a successfully accepted cancellation.

Cancelling an HTTP request or event-stream reader with an `AbortSignal` remains a local transport
operation. It does not imply server-side turn or session cancellation. Client docs and types must
keep that distinction explicit.

The eval driver also exposes first-class cancellation for an active turn and for its entry session.
An eval must be able to start or attach to work, retain a cancellable handle while that work is
active, issue cancellation, and continue observing events through the resulting boundary. Expected
cancellation is an assertable eval outcome rather than an automatic eval failure.

These eval controls use the TypeScript client and public channel contracts; they do not access
runtime or workflow internals. They must work for sessions created by custom channels as well as the
built-in eve channel.

### 3. Channel orchestration

The channel layer owns conversation identity and therefore owns reset orchestration. It receives
channel-local continuation tokens and delegates lifecycle changes to the runtime without exposing
workflow SDK primitives.

Custom `defineChannel` routes receive high-level operations for the complete cancellation contract:

- cancel an active turn using its session-bound turn capability;
- cancel the entry session addressed by a channel-local continuation token;
- restart that session with replacement input.

The turn and session operations are distinct so scope cannot be selected accidentally. Restart is a
single safe composition: close and cancel the old session, wait until its continuation identity is
released, then start the replacement. Channel authors should not need to reproduce the ordering or
namespace tokens themselves.

Higher-level channel factories expose the same intent through an inbound `reset-session` decision.
This lets a custom Slack `onAppMention` or `onDirectMessage` handler request reset without reaching
into route or workflow internals. Supplying replacement content starts a fresh session; omitting it
performs a bare reset.

In-session callbacks and event subscribers receive an explicit cancellation operation with a
required `turn` or `session` scope. The operation exits normal execution through framework control
flow so authored code cannot accidentally continue after requesting cancellation.

### 4. Runtime cancellation coordinator

The runtime is the single authority for lifecycle transitions. It validates the target, records the
cancellation request durably, and moves the target through `active` → `cancelling` → `cancelled`.

For session scope, the coordinator performs these actions in order:

1. Bind the request to the currently active entry session.
2. Mark the entry as closing so it cannot accept deliveries, re-register its continuation, dispatch
   another turn, or create another descendant.
3. Release the continuation identity. This is the reset linearization point.
4. Propagate cancellation through the active ownership tree, including remote descendants.
5. Wait for each branch to acknowledge cancellation or be terminated by the runtime.
6. Record `session.cancelled`, complete callbacks and instrumentation, and close the old event
   stream.

Turn scope uses the same descendant propagation but stops at the turn boundary. Once its tree has
settled, the entry session returns to waiting instead of becoming terminal.

### 5. Workflow execution

Workflow code implements the lifecycle requested by the coordinator, but does not define public
cancellation policy. It must expose durable points where the coordinator can close ingress, signal
active execution, observe descendant completion, and record terminal state.

The workflow implementation must preserve four invariants:

- closing a session is monotonic and cannot be reversed;
- a closing session cannot launch or resume user work;
- descendant results cannot restart a cancelled ancestor;
- continuation identity is released exactly once and cannot be reclaimed by the old entry.

The implementation can evolve independently as long as those invariants and the public lifecycle
contract remain true.

## `/new` channel flow

Telegram and Twilio intercept `/new` at the authenticated pre-dispatch boundary:

1. Verify the provider webhook signature.
2. Parse the provider event and reject bots, unsupported shapes, or disallowed senders.
3. Run the authored inbound handler so custom gating and auth projection still apply. Returning
   `null` drops the input and must not cancel anything.
4. Match the configured reset command at a complete command boundary.
5. For a bare reset, request session cancellation and stop.
6. For replacement content, request restart and dispatch the stripped content only after the old
   session has released the identity.

The reset command itself is never appended to model history. Existing auth, channel context, upload
policy, attachments, and adapter state seeding apply normally to replacement content.

The parser is a small reusable channel utility. It matches case-insensitively, rejects prefixes such
as `/newspaper`, and supports Telegram's `/new@botname` form only when the suffix targets the current
bot.

Telegram and Twilio expose:

```ts
resetCommands?: false | readonly string[];
```

- omitted: `['new']`;
- `false`: disable interception;
- array: replace the default list with explicitly configured names.

Unknown or disabled commands remain ordinary model input.

## Concurrency and race behavior

The continuation release is the reset linearization point.

- Input accepted before that point belongs to the old session and is discarded as part of reset.
- Input arriving after that point cannot enter the old session and may start or join the replacement.
- Reset-plus-message waits for the old session's release before creating the replacement.
- Duplicate channel resets are idempotent: the first closes the session and later requests observe
  no active target.
- A public API request using a stale capability receives `409` rather than cancelling a newer
  session.
- A reset racing natural completion succeeds if it closes the old continuation, but does not rewrite
  a completed session as failed.
- Late descendant results are recorded against the old tree and cannot append messages or state to
  the replacement session.
- Cancellation cleanup always remains bound to the old session id, so it cannot terminate a new
  session that later reuses the channel identity.

## Implementation plan

1. Define shared turn and session cancellation outcomes, stream events, callback states, and
   capability validation rules.
2. Add the runtime cancellation coordinator and ownership-tree propagation for active local and
   remote work.
3. Make workflow execution obey the closing-state invariants and surface intentional terminal
   cancellation.
4. Expose the scoped eve HTTP route and channel-level turn-cancel, session-cancel, and restart
   operations.
5. Update the TypeScript client with first-class turn and session cancellation, then surface the
   same lifecycle controls through the eval driver.
6. Add the reusable inbound reset decision and command matcher for higher-level channel factories.
7. Enable `/new` by default in Telegram and Twilio, preserving auth, attachments, context, and
   silent behavior.
8. Document cancellation scopes, TypeScript client usage, eval usage, custom-channel usage,
   event-subscriber usage, and stream outcomes.
9. Add a patch changeset for the new public behavior.

## Test plan

### Contract tests

- Accept each valid HTTP scope and reject omitted, invalid, or crossed scopes and capabilities.
- Authenticate before capability inspection and reject a capability bound to another session id.
- Verify turn cancellation leaves the entry resumable and session cancellation makes it terminal.
- Verify clients, callbacks, hooks, and instrumentation distinguish cancellation from failure.
- Verify the TypeScript client sends the correct scoped request, retains the active turn capability,
  clears terminal session state correctly, and does not confuse local `AbortSignal` use with
  server-side cancellation.
- Verify eval cancellation can interrupt active work, capture the cancellation boundary, and treat
  the expected outcome as an assertion target rather than a harness failure.

### Channel tests

- Match `/new`, mixed case, whitespace, Telegram bot suffixes, and trailing replacement content.
- Reject command prefixes, wrong Telegram bot suffixes, disabled commands, and unknown commands.
- Run authored auth and gating before reset.
- Preserve Telegram attachments and channel context in the replacement session.
- Keep bare reset silent and avoid creating an empty session or default typing indicator.
- Exercise a custom command list, a custom `defineChannel` route, a Slack inbound reset decision, and
  an event subscriber requesting session cancellation.

### Runtime tests

- Cancel an idle entry, active model call, authored tool, sandbox operation, input wait,
  authorization wait, local delegate, nested delegate, and remote delegate.
- Verify every active descendant settles and no cancelled ancestor resumes the model.
- Verify the old continuation cannot be reclaimed after reset.
- Race reset with delivery, natural completion, descendant completion, duplicate reset, and immediate
  replacement creation.
- Verify completed external side effects remain recorded while unfinished work stops.

### Dedicated cancellation e2e fixture

Add a new `e2e/fixtures/agent-cancellation` fixture. Do not fold these cases into an existing fixture:
the fixture is the executable proof that a fully custom channel can implement the complete
cancellation contract using only public `defineChannel` APIs.

Its custom channel exposes deterministic test routes for starting a controlled cancellable turn,
cancelling that turn, cancelling its entry session, sending a follow-up, and reusing the same
channel-local continuation identity. The routes return the session identifiers and capabilities the
evals need; they must not import runtime or workflow internals or proxy through the built-in eve
cancellation route.

The fixture contains at least two independent evals. They use the new eval cancellation controls to
drive the lifecycle while the custom channel exercises the public channel cancellation operations:

- **Turn cancellation:** start a turn that remains active long enough to cancel, cancel it through
  the custom channel, assert the turn tree reaches its cancellation boundary and the entry returns
  to waiting, then send a follow-up and prove it resumes the same session with its prior context.
- **Session cancellation:** start an equivalent active turn, cancel the entry through the custom
  channel, assert the old stream reaches `session.cancelled` and all active work settles, then reuse
  the same channel identity and prove the resulting session id, history, and authored state are
  fresh.

The fixture must be deterministic and self-contained, work against both local and deployed eval
targets, and require no external service startup or credentials beyond the normal model provider.
The evals should assert lifecycle events and session identity directly rather than relying only on a
judge's interpretation of model text.

### End-to-end acceptance

- A Telegram private chat or Twilio phone pair can run `/new`, then send an ordinary message and
  receive a response with no prior history or authored state.
- `/new explain this` produces exactly one response from a fresh session.
- `/new` plus a Telegram attachment starts a fresh session containing that attachment.
- Session reset during nested local or remote work stops the complete old tree.
- Turn cancellation preserves the original session and its context.
- The eve channel exposes one cancellation route with an explicit required scope.
- Intentional cancellation never appears to the user as an ordinary agent failure.

## Required verification

Run focused tests with the appropriate tier configuration while iterating, then complete:

```sh
pnpm test:unit
pnpm test:integration
pnpm test:scenario
pnpm typecheck
pnpm lint
pnpm fmt
pnpm guard:invariants
pnpm docs:check
pnpm build
```

Run the relevant channel end-to-end eval when model credentials are available and report explicitly
when they are not. The new fixture is mandatory verification:

```sh
cd e2e/fixtures/agent-cancellation
pnpm exec eve eval --strict
```
