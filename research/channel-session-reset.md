---
issue: https://github.com/vercel/eve/issues/216
last_updated: "2026-06-23"
status: proposed
---

# Channel session reset and scoped cancellation

## Summary

Identity-based channels such as Telegram private chats and Twilio conversations reuse one
channel-derived continuation token indefinitely. Every inbound message therefore resumes the same
long-lived `workflowEntry`, and its history and state continue to grow. Users need a way to end
that entry workflow and let the same channel identity start a clean session.

Implement two distinct cancellation operations behind one explicit HTTP endpoint:

- **turn cancellation** stops the active turn and delegated work while keeping the parent session
  resumable;
- **session cancellation** revokes the continuation, stops the active turn and delegated work, and
  terminates the parent `workflowEntry`.

Telegram and Twilio should recognize `/new` and `/clear` by default. A bare reset command ends the
old session without creating an empty replacement. A reset command followed by content ends the old
session and dispatches that content as the first turn of a fresh session. Both forms are silent:
there is no reset confirmation, and only replacement content can produce a normal agent response.

The implementation must expose the underlying behavior independently of slash-command parsing so
that authors can reproduce it from a custom `defineChannel` route, a Slack `onAppMention` or
`onDirectMessage` handler, or a session event subscriber.

## Current architecture and failure mode

- `send()` namespaces the channel's raw continuation token and first calls `Runtime.deliver()`. If
  no live hook owns that token, it falls back to `Runtime.run()` and creates a new `workflowEntry`.
- `workflowEntry` owns the continuation hook and durable session state. It dispatches each model
  turn as a child `turnWorkflow`.
- Telegram private chats derive a stable token from the chat. Twilio derives one from the phone
  number pair. Reusing those tokens is correct for normal conversation continuity but gives users
  no clean-session boundary.
- The pending turn-cancellation work in #118 adds
  `POST /eve/v1/session/:sessionId/cancel` with a one-turn `cancelToken`. That operation deliberately
  leaves `workflowEntry` parked, so it cannot implement `/new` or `/clear`.
- The stacked work in #128 and #135 propagates turn cancellation through delegated local and remote
  runtime actions. Session cancellation must reuse that machinery rather than introduce a second,
  weaker descendant-cancellation path.
- Directly abandoning a client cursor is insufficient. The old workflow remains live, owns its
  continuation hook, and can continue accumulating state or running delegated work.
- Directly cancelling only the parent run is also insufficient unless the active child turn and
  delegated descendants are explicitly stopped and the continuation hook cannot be recreated.

## Goals

1. A reset produces a genuinely new entry workflow, history, authored state, session id, and event
   stream while retaining the channel's stable identity token.
2. Session cancellation works while the entry is idle, running a turn, waiting for input or
   authorization, or waiting for delegated local or remote work.
3. The API makes turn-versus-session intent explicit at every ambiguous boundary.
4. Channel authors can use the same behavior without depending on Telegram or Twilio internals.
5. Authentication and channel allow-list decisions run before any reset can affect a session.
6. Races cannot allow the cancelled entry to reclaim its continuation token or process buffered
   input after the reset linearizes.
7. Intentional cancellation is observable as cancellation, not reported as an ordinary agent
   failure.

## Non-goals

- Do not erase workflow records, prior event streams, logs, or telemetry. Reset severs future
  continuation; it is not data deletion.
- Do not attempt to undo external side effects that completed before cancellation was accepted.
- Do not add default Slack reset commands. Slack threads already create natural conversation
  boundaries; Slack authors can opt into the shared handler directive or parser.
- Do not add compatibility behavior for the unmerged, unscoped #118 request body.
- Do not make slash commands a runtime concern. Runtime APIs operate on sessions; channel code owns
  parsing and transport behavior.

## API design

### 1. Runtime boundary

Keep separate runtime primitives because their capabilities and lifecycle guarantees differ:

```ts
interface Runtime {
  cancelTurn(sessionId: string, cancelToken: string): Promise<boolean>;

  cancelSession(input: {
    continuationToken: string;
    expectedSessionId?: string;
  }): Promise<CancelSessionResult>;
}

type CancelSessionResult = { status: "cancelled"; sessionId: string } | { status: "not-active" };
```

`cancelTurn` preserves the semantics from #118: the token is scoped to one active turn, the parent
entry remains alive, and the session returns to `session.waiting`.

`cancelSession` accepts a fully namespaced continuation token. It resolves the token to the current
entry run, optionally verifies `expectedSessionId`, and requests terminal cancellation of that entry
and its active execution tree. A mismatched expected id returns `not-active`; it must never cancel a
different session.

The method resolves only after the entry has durably acknowledged cancellation, released its
continuation hook, and initiated cancellation for all known descendants. This guarantee makes it
safe for channel orchestration to reuse the same identity token immediately.

### 2. Channel route boundary

Extend `RouteHandlerArgs<TState>` with two channel-scoped operations:

```ts
interface RouteHandlerArgs<TState> {
  // Existing operations omitted.
  cancelSession(input: {
    continuationToken: string;
    expectedSessionId?: string;
  }): Promise<CancelSessionResult>;

  restartSession(
    input: string | UserContent | SendPayload,
    options: SendOptions<TState>,
  ): Promise<Session>;
}
```

Both functions accept the channel-local raw continuation token, exactly like `send()`. The route
dispatcher applies the current channel namespace before calling the runtime. This prevents custom
channels from accidentally double-prefixing tokens or reaching another channel's session.

`restartSession()` is the safe composition for reset-plus-message: it awaits `cancelSession()` and
then starts a new run with the supplied input and options. It must not use a stale delivery path or
dispatch replacement input before the old hook has been released. A missing active session is a
successful precondition—the function simply starts the new one.

For a reset with no replacement content, call `cancelSession()` only. Keeping this separate avoids
creating empty entry workflows.

### 3. Inbound handler boundary

Introduce a shared inbound decision type and use it as the base for Telegram, Twilio, and Slack
pre-dispatch result types:

```ts
type ChannelInboundDecision<TMessage = string | UserContent> =
  | {
      action?: "dispatch";
      auth: SessionAuthContext | null;
      context?: readonly string[];
    }
  | {
      action: "reset-session";
      auth: SessionAuthContext | null;
      context?: readonly string[];
      message?: TMessage;
    }
  | null;
```

Existing `{ auth, context? }` handlers continue to dispatch normally. Returning
`{ action: "reset-session", auth }` cancels without dispatch. Supplying `message` performs a reset
and uses that value as the new session's first message.

This gives a custom Slack handler an explicit, transport-independent path:

```ts
onAppMention(ctx, message) {
  const reset = matchSessionResetCommand(message.markdown);
  if (reset === null) return { auth: deriveAuth(ctx, message) };

  return {
    action: "reset-session",
    auth: deriveAuth(ctx, message),
    message: reset.remainder || undefined,
  };
}
```

`defineChannel` authors who control their own routes use `cancelSession()` or `restartSession()`
directly. The directive exists for higher-level channel factories whose handlers do not receive
route operations.

### 4. Session callback boundary

Add an explicit authored control-flow operation to `SessionContext.session`:

```ts
ctx.session.cancel({ scope: "turn" | "session" }): never;
```

This form is intentionally synchronous and returns `never`. Calling it from a tool, hook, dynamic
instruction callback, or channel event throws a framework-owned control signal. The runtime catches
that signal at the execution boundary and performs the requested cancellation without treating it
as an authored exception. It must not call back into the current workflow and await its own
termination, which would deadlock.

The explicit scope prevents an event subscriber from accidentally ending the whole conversation
when it intended to stop only one turn. Terminal-event contexts must reject a second cancellation
request as already terminal.

### 5. eve HTTP cancellation route

Expose one route on `eveChannel()`:

`POST /eve/v1/session/:sessionId/cancel`

The body is a strict discriminated union:

```ts
type CancelRequest =
  | { scope: "turn"; cancelToken: string }
  | { scope: "session"; continuationToken: string };
```

Rules:

- `scope` is required. There is no default and no unscoped compatibility fallback.
- Reject a missing token, an empty token, both token fields, the wrong token for the selected scope,
  or unknown top-level fields with `400`.
- Run `eveChannel` route authentication before parsing or inspecting capability tokens.
- For turn scope, validate the cancellation hook metadata belongs to `:sessionId`.
- For session scope, namespace the supplied eve-channel continuation token and verify its active hook
  belongs to `:sessionId`.
- A valid request returns `202` with:

  ```json
  { "cancelled": true, "ok": true, "scope": "session" }
  ```

- A missing, stale, terminal, or mismatched target returns the same non-disclosing response:

  ```json
  {
    "cancelled": false,
    "code": "CANCELLATION_TARGET_NOT_ACTIVE",
    "ok": false,
    "scope": "session"
  }
  ```

  with status `409`.

- Every response sets `cache-control: no-store`.

Update #118 rather than adding a second session endpoint. Update #127 so
`MessageResponse.cancel()` sends `{ scope: "turn", cancelToken }`.

## Workflow cancellation model

### Durable control path

Session cancellation needs a control path that remains reachable while `workflowEntry` is blocked
on an active child turn. Reusing the ordinary delivery iterator is insufficient because the driver
does not consume that iterator at every active-turn wait point.

For every entry run:

1. Register a dedicated session-cancellation hook derived from the entry run id and tagged with that
   session id.
2. Keep an always-available internal cancellation token for each child turn, even when the channel
   did not request or expose a public turn `cancelToken`.
3. Race the session-cancellation signal at every driver wait boundary: active turn completion,
   runtime-action results, authorization, input, and idle parking.
4. On session cancellation, mark the driver as closing before any asynchronous cleanup. Once set,
   this state forbids hook rekeying, new turns, new delegated actions, and processing buffered
   deliveries.
5. Dispose the park hook first so new input using the same channel identity can no longer enter the
   old session.
6. Cancel the active child turn through the same cooperative signal used by turn cancellation.
7. Invoke the shared #128/#135 local and remote runtime-action cancellation path and await its
   durable acknowledgements. Do not fork a second descendant traversal.
8. Dispose authorization, completion, and control hooks; discard buffered deliveries and pending
   input/authorization work.
9. Record an intentional terminal cancellation outcome and terminate the entry run.

The terminal projection should be `session.cancelled`, not `session.failed`. Add that status wherever
session terminal state is represented: stream events, callback payloads, client reducers, event maps,
and instrumentation. Built-in channels do nothing for `session.cancelled`, preserving silent reset
behavior. If an active turn emits a cancellation boundary while the tree shuts down, default
`turn.failed` handlers must recognize the cancellation code and avoid sending an error message.

### Linearization and races

The reset linearization point is durable disposal of the old continuation hook after the entry has
entered closing state.

- A delivery accepted before that point belongs to the old session and is discarded when reset
  wins; it must not run after reset.
- A delivery after that point cannot reach the old entry. Normal `send()` fallback starts a new
  entry with the same channel-local token.
- Two simultaneous resets are idempotent at the channel helper layer. One cancels the entry; the
  other observes no active session and succeeds as a no-op.
- The public HTTP route retains `409` for stale capabilities so API callers can detect that their
  cancellation did not target a live operation.
- A reset racing natural completion is successful if the hook was revoked by either path. It must
  never turn a completed session into a failure or cancel a newer run that later acquired the same
  channel token.
- `restartSession()` must bind cancellation to the resolved old session id and re-check ownership so
  a late cleanup cannot cancel the replacement run.

## Slash-command behavior

### Shared parser

Export a pure `matchSessionResetCommand()` helper from `eve/channels`. It accepts text, a list of
command names, and an optional Telegram bot username, and returns:

```ts
type SessionResetCommandMatch = {
  command: string;
  remainder: string;
};
```

or `null`.

Parser rules:

- Match only at the beginning of trimmed text.
- Match command names case-insensitively at a complete command boundary.
- Accept `/new@botname` only when the suffix matches the configured Telegram bot username.
- Strip the command and surrounding whitespace but preserve the remainder's content.
- Do not treat prefixes such as `/newspaper` as `/new`.
- Validate configured names once when the channel factory is created; reject empty names, leading
  slashes, whitespace, mention suffixes, and duplicates after case normalization.
- Unknown or disabled commands remain ordinary model input.

### Channel configuration

Add this option to Telegram and Twilio:

```ts
resetCommands?: false | readonly string[];
```

- Omitted: `['new', 'clear']`.
- `false`: disable interception.
- An array: replace the default names.

Telegram applies commands to inbound message text and captions. Twilio applies them to SMS bodies
and literal voice-transcription text. There is no fuzzy recognition of spoken “slash new.”

### Interception order

For Telegram and Twilio:

1. Verify the platform webhook signature.
2. Parse the platform event and reject bots, disallowed senders, or unsupported message shapes.
3. Run the authored `onMessage`, `onText`, or `onVoiceTranscription` hook to obtain auth and honor
   custom gating. A `null` result always wins and drops the request without cancellation.
4. Honor an explicit `reset-session` decision from the authored hook.
5. Otherwise match configured reset commands.
6. Execute `cancelSession()` or `restartSession()` instead of normal `send()`.

Default Telegram handling should avoid starting the typing indicator for a recognized bare reset.
Side effects deliberately performed by an authored hook remain the author's responsibility.

### Message semantics

- `/new` and `/clear` are aliases with identical behavior.
- A bare command cancels the current session and sends no reply.
- A non-empty remainder becomes the replacement session's first message and receives the normal
  agent response.
- Telegram attachments accompanying a reset are replacement content. Preserve them and replace only
  the command-bearing text or caption. `/new` plus an attachment therefore starts a fresh session
  containing that attachment rather than acting as a bare reset.
- Preserve channel context blocks, auth, upload-policy enforcement, and initial adapter state for the
  replacement message.
- Do not emit a synthetic user message containing the reset command.
- Do not post confirmation or cancellation-error text for successful resets.

Telegram group and forum behavior continues to follow existing continuation-token granularity. A
reset only affects the session addressed by the current chat/thread/conversation token; it does not
clear unrelated threads in the same group.

## Implementation sequence

1. **Reconcile the cancellation stack.** Land or rebase #118, #127, #128, and #135. Change #118's
   route contract to the required scoped body and #127's client call to `scope: "turn"` before
   building session reset on top.
2. **Add intentional terminal cancellation.** Extend protocol types, reducers, callbacks, event
   maps, and instrumentation with `session.cancelled`; ensure default channel handlers remain silent.
3. **Implement runtime session cancellation.** Add the dedicated entry control hook, internal
   per-turn cancellation token, closing-state invariant, hook disposal, and shared recursive
   descendant cancellation.
4. **Expose channel primitives.** Add `cancelSession` and `restartSession` to route arguments with
   channel-local token namespacing, plus `ctx.session.cancel({ scope })` for authored in-session code.
5. **Expose inbound decisions and parsing.** Add `ChannelInboundDecision`, the reset directive, and
   the pure command matcher. Adapt Slack, Telegram, and Twilio result aliases without exposing
   transport-specific internals.
6. **Integrate Telegram and Twilio defaults.** Add `resetCommands`, intercept at the authenticated
   pre-dispatch boundary, preserve replacement content, and keep bare reset silent.
7. **Finalize the eve route.** Dispatch the strict request union to the appropriate runtime
   primitive and document capability ownership and response semantics.
8. **Document and release.** Update eve, custom-channel, Telegram, Twilio, Slack customization,
   sessions/streaming, auth, and client cancellation docs. Add a patch changeset; the prior unscoped
   route is unmerged and receives no compatibility path.

## Test plan

### Unit tests

- Parser: both defaults, case normalization, leading/trailing whitespace, boundary rejection,
  Telegram `@bot` matching/mismatch, custom lists, invalid configuration, disabled commands, and
  remainder extraction.
- Content rewriting: text-only, caption, attachment-only replacement, text plus attachments, and
  preservation of channel context.
- Route body: valid turn/session variants; missing scope; missing, empty, extra, or crossed token
  fields; invalid JSON; missing session id; auth-before-token processing; no-store headers.
- Capability binding: turn token and continuation token cannot cancel another session id.
- Channel helpers: raw token is namespaced exactly once; `restartSession` waits for cancellation;
  not-active is safe; a mismatched expected id never starts destructive cleanup.
- Inbound decisions: existing `{ auth }` behavior remains unchanged; reset with and without
  replacement content; `null` gating wins.
- Callback control flow: both scopes become runtime cancellation, not authored exceptions; code
  after `ctx.session.cancel()` cannot execute.

### Integration tests

- Cancel an idle entry and verify its continuation hook disappears and the next send creates a new
  session id with empty history/state.
- Cancel during model generation, authored tool execution, authorization, input waiting, local
  delegation, nested local delegation, remote delegation, and code-mode runtime actions.
- Verify every active descendant reaches a cancellation terminal state and no parent resumes the
  model with cancellation errors.
- Verify turn scope still returns the original parent session to `session.waiting` and accepts a
  follow-up with existing history.
- Verify session scope closes the old stream with `session.cancelled`, does not emit
  `session.failed`, and lets the same continuation token start a new entry.
- Race cancellation against natural turn completion, hook registration, continuation rekeying,
  concurrent delivery, duplicate reset, and immediate replacement delivery.
- Exercise a custom `defineChannel` route using both helpers, a Slack mention handler returning the
  reset directive, and an event subscriber calling `ctx.session.cancel({ scope: "session" })`.

### Scenario and end-to-end tests

- Add deterministic dev-server scenarios proving reset during nested local and remote work and a
  clean follow-up on the reused identity token.
- Extend channel scenarios with signed Telegram and Twilio webhook requests for bare and inline
  resets, including disabled/custom command configuration and auth rejection.
- Run the `agent-channels` fixture eval if its model credentials are available; report explicitly if
  they are not.

### Required verification

Run focused tests with their tier configs while iterating, then complete:

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

## Acceptance criteria

- A Telegram private chat or Twilio phone pair can run `/new`, then send an ordinary message and
  receive a response with no prior conversation history or state.
- Bare `/new` and `/clear` produce no message, no typing indicator from defaults, and no empty
  workflow.
- `/new explain this` produces exactly one normal response from a new session.
- Session reset during active delegated work stops the entry, active turn, and all known local and
  remote descendants.
- Turn cancellation still preserves the entry and prior context.
- The eve channel exposes only the single scoped cancellation endpoint, and an omitted scope is
  rejected.
- A capability cannot cancel a session other than the one in the URL.
- Custom `defineChannel`, Slack inbound handlers, and session event subscribers can all trigger the
  same session-reset semantics through documented public APIs.
- Intentional cancellation never appears to users as a normal agent error.
