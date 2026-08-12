---
issue: https://github.com/vercel/eve/issues/1224
status: proposed
last_updated: "2026-08-11"
---

# HITL requests must not wedge sessions

## The problem

Today, a user can send a message while an approval is waiting and get no useful
response.

```text
approval waits
  -> user sends a message
  -> eve hides the message in deferredStepInput
  -> eve waits for the approval again
```

No model call runs. If nobody answers the approval, the message stays hidden.
The session looks broken. The same defect exists one layer down: while a
connection-authorization challenge is open, the session driver reads only the
callback hook, so ordinary deliveries are never admitted at all.

Both wedges are one bug wearing two coats: **an obligation encoded as a blocked
continuation** — "the code is waiting on X, therefore only X can arrive" —
instead of as data the session carries while remaining receptive. The
mitigations ([#1830], [#1868]) removed the two blocked continuations. This
document defines the end state they were aiming at: a state machine in which
every open request, challenge, and prompt is a row in durable state, every
delivery is interpreted against those rows by one pure function, and nothing
the session receives is ever silently consumed.

Three rules carry over unchanged from the original proposal:

1. **Pending requests never block the conversation.** A message runs as a
   normal turn. The request just stays unanswered.
2. **Do not steal someone else's request.** A message cannot approve, deny,
   cancel, dismiss, or replace an existing HITL request.
3. **Show request closure.** Emit `input.requested` before waiting, then emit a
   settlement event or `input.dismissed` when the request stops being usable.

## Who owns what

- The **owner session** stores and settles the request. A child agent owns its
  own request even when a parent shows that request to the channel.
- The **originating actor** is the user whose turn created the request.
- The **current actor** is the user sending the new message or response.

These are different identities. Session admission does not grant permission to
change a HITL request.

## State model

### Obligations

An **obligation** is one open item the session owes an answer to. Four kinds:

- **Approval** — human consent for one tool call.
- **Question** — an `ask_question` prompt.
- **Limit** — a session-limit continuation prompt, carrying a monotonic
  `generation`.
- **Challenge** — a connection-authorization challenge (OAuth credentials,
  not consent).

Each obligation is a small state machine. Terms:

- **Open:** the obligation can still be answered.
- **Settled:** an accepted response closed it.
- **Dismissed:** it closed without an accepted response.
- **Completed:** terminal state of a challenge (challenges are not input
  requests; their terminal vocabulary is the authorization outcome).

```text
Approval(id)   open ──accepted allow──────────▶ settled(allowed)
               open ──authenticated cancel────▶ settled(cancelled)
               open ──owning turn cancelled───▶ dismissed(cancelled)
               open ──session ended───────────▶ dismissed(session-ended)
               open ──rejected / failed───────▶ open        (candidate event only)

Question(id)   open ──accepted answer─────────▶ settled(answered)
               open ──originating-actor msg───▶ dismissed(superseded)
               open ──cancel / session end────▶ dismissed(…)

Limit(gen)     open ──continue────────────────▶ settled(continued)
               open ──stop────────────────────▶ settled(stopped)
               open ──any message─────────────▶ dismissed(superseded),
                                                Limit(gen+1) opens
               // a response naming gen-1 is rejected as stale

Challenge(id)  open ──callback────────────────▶ completed(authorized |
                                                declined | failed)
               open ──deadline────────────────▶ completed(timed-out)
               open ──cancel / session end────▶ completed(cancelled)
               completed ──late callback──────▶ completed   (event only)
```

**Single winner.** Every obligation has at most one terminal transition. The
identity of a competing attempt is its **candidate**: eve derives
`candidateId` from `{ requestId, deliveryId }`, where `deliveryId` is assigned
by the server at admission — the HTTP API gains no new request field. A
workflow-level redelivery of the same admitted delivery reuses the candidate;
a new delivery creates a new candidate and participates in the obligation's
atomic single-winner transition. After one candidate wins, later candidates
are stale and later dismissals are no-ops. A client-supplied idempotency key
is possible later as an optional, additive field.

**Adjudication.** For approvals, the response policy decides on a correlated
candidate: allow or reject. An allowed candidate settles the obligation as
`allowed`. A rejected candidate never settles: the obligation stays open for
another responder, and the rejection becomes turn context so the agent can
react. Allow uses the tool's response authorizer. Cancel requires an
authenticated actor and bypasses the Allow authorizer. Question answers and
Limit Continue/Stop use their owning tool or runtime gate. Policy throw or
timeout is not an adjudication.

- **Response:** a structured `InputResponse` naming an open `requestId`. Only
  channels construct responses, from an explicit user interaction with the
  rendered request — a button, select, modal, or a channel-owned reply mapping
  where the channel knows exactly which prompt the user saw.
- **Message:** any delivery content that is not a response. The runtime never
  reinterprets message text as a response. Whether a message semantically
  relates to an open obligation is the agent's job inside the turn.

### Authorized approval responses — shipped approval state machine

The response-authorizer stack implements one durable state machine inside the
larger model. A tool may use `approval: { request, response }`: `request`
decides whether to ask, and `response` decides whether a submitted **Approve**
is allowed for its verified responder. A function-form approval has no response
authorizer, so an authenticated structured Approve settles directly as before.

The coordinator owns a durable approval audit state alongside the pending
request batches:

```text
ApprovalAuditState
  activeCandidates  candidateId -> { requestId, responder, status,
                                     expiresAt, authorizationChallenges? }
  candidateHistory  terminal candidate records
  settlements       requestId -> { allowed | cancelled, actor, candidateId? }

open request + authenticated Approve
  -> no response authorizer: settle allowed
  -> response authorizer: active candidate(pending)

active candidate(pending) -- authorizer allowed -----------------> settlement(allowed)
active candidate(pending) -- authorizer rejected / failed / timeout -> history; request open
active candidate(pending) -- needs credentials ------------------> candidate(authorization-required)
candidate(authorization-required) -- matching callback ----------> re-run authorizer
any open request -- authenticated Cancel -------------------------> settlement(cancelled)
settlement -------------------------------------------------------> all sibling candidates stale
```

For an authorizer-backed request, an authenticated Approve creates one active
candidate per `{ requestId, responder identity }`. Repeated Approve deliveries
from that responder coalesce while its candidate is active; different
responders may be evaluated concurrently. This is the shipped identity rule,
not yet the target `{ requestId, deliveryId }` identity above. The first
allowed candidate atomically settles the shared approval and archives all
competitors as stale. Rejected, failed, and timed-out candidates only close
their own attempt; the shared approval remains open. Cancel is authenticated,
bypasses the response authorizer, and atomically settles the shared approval
as cancelled.

A response authorizer receives a responder-bound `auth` capability. If it
needs credentials, `auth.getToken()` parks that candidate on a
candidate-correlated connection-authorization challenge. A callback re-runs
the response authorizer for the same responder. Cancel or another winning
candidate closes outstanding candidate challenges, and a late callback is
stale. Candidate expiry is ten minutes; authorizer failure or a ten-second
authorizer timeout fails that candidate without closing the approval.

The coordinator deliberately commits candidate creation or Cancel before it
runs an authorizer. A later coordination pass runs pending candidates, commits
the result, and only then the tool loop projects lifecycle events. This keeps
Cancel and competing candidates atomic even when an authorizer is slow or
parks for OAuth. It also means the approval state machine is real today, while
its pending batches, authorization state, and routing are still separate
stores and coordinators.

The shipped stream vocabulary is deliberately additive while the target
lifecycle-event family below is still gated:

- `approval.candidate` reports a responder-bound candidate as `pending`,
  `rejected`, `failed`, `timed-out`, or `stale`. It carries `candidateId`,
  `requestId`, and `responderPrincipalId`; its reason is safe for that
  responder only.
- `approval.settled` is the shared terminal event. It carries `requestId`,
  `responderPrincipalId`, and `approved` or `cancelled`.
- A candidate's authorization challenge uses the existing
  `authorization.required` / `authorization.completed` events correlated by
  `candidateId`.

Channels keep shared approval controls visible after an Approve candidate is
submitted and remove them only after `approval.settled`. Candidate progress
and its authorization challenge are responder-scoped; an owner or projector
must not present them as a public shared decision.

### Groups and continuations

Obligations raised by one park form a **group**, and every group carries a
**continuation** that fires exactly once when the group closes ordinarily:

| Group         | Members                                         | Continuation on ordinary closure                                                                        |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ApprovalBatch | approvals and questions from one assistant turn | restore the withheld model output once, append every member outcome, run each allowed tool exactly once |
| AuthGroup     | challenges from one park                        | re-drive the blocked turn with every callback result available                                          |
| LimitPrompt   | one Limit(gen)                                  | grant a fresh budget window (continued) or cancel the turn (stopped)                                    |

Closure is derived, never stored: a group is closed exactly when every member
is terminal. Rules:

- Settling one member of a multi-member group leaves its siblings open and
  does **not** fire the continuation (the withheld output appears zero times
  in committed history until closure).
- **Forced closure** — turn cancellation or session end dismissing the
  members — never fires the continuation: no restored output, no batch tool,
  no model call.
- Tools whose approval settled as denied or cancelled do not run. Rejected
  candidates do not change a member's later eligibility.
- Tool dispatch rechecks turn and session cancellation after the continuation
  wins and before execution.

ApprovalBatch and AuthGroup are deliberately the same shape. Today they are
two mechanisms (batch splice vs. driver-side callback counting); the end state
needs one, which also fixes multi-challenge semantics for free: each callback
settles its own challenge (with its own events), and the blocked turn resumes
once, when the last challenge completes.

### Projections

A parent session that surfaces a child-owned request runs a second, simpler
machine per request: a **route**.

```text
Route(requestId)  absent ──child raises───────▶ active     (parent re-emits
                                                            input.requested)
                  active ──child closes───────▶ dropped    (parent re-emits the
                                                            closure, scope:
                                                            projection)
                  active ──route unusable─────▶ dropped    (input.dismissed,
                                                            scope: projection,
                                                            reason: route-lost)
                  dropped ──response arrives──▶ dropped    (reject stale;
                                                            never resumes the
                                                            child)
```

The projector never settles anything. It mirrors: responses forward down with
the verified responder unchanged; the child evaluates its own response policy
and remains the only owner. Routes accumulate per request — a child raising a
fresh batch must not drop routes for its still-open earlier requests. Owner
events use the request's originating turn coordinates; projection events keep
those coordinates and change only `scope`.

### Scheduler

```text
Receptive ──delivery admitted──▶ TurnActive ──turn ends──▶ Receptive
Receptive ──cancel / expire / session end──▶ terminal
```

That is the whole scheduler. There is no `AwaitingApproval` and no
`AwaitingAuthorization` — those were the two wedges. The session is **always
receptive**: every delivery is admitted, interpreted, and answered with
observable events. Deliveries that arrive during `TurnActive` buffer in
arrival order and are interpreted at the next boundary.

The one licensed irregularity is an open `Limit(gen)`: it changes what a
_message_ means (supersede-and-re-prompt instead of a model call), because its
entire purpose is to stop spend. Even then the delivery is admitted and
produces observable output — nothing is invisibly buffered.

### Input alphabet

External deliveries — one arrival-ordered stream:

| Input                                               | Carries                                                 |
| --------------------------------------------------- | ------------------------------------------------------- |
| `Message(actor, text, context?)`                    | plain content; never reinterpreted as a response        |
| `Responses(actor, [{requestId, optionId \| text}])` | one or more structured responses                        |
| `Compound(actor, responses, message)`               | both in one delivery; each part processed exactly once  |
| `Callback(name, params)`                            | a connection-authorization callback                     |
| `CancelTurn`, `Clear`, `Compact`, `Reset`           | session controls                                        |
| `SessionTimeout`                                    | the session deadline, delivered through the same stream |

Timers: `Deadline(challengeId)` — the authorization deadline is a first-class
input, not an artifact of a wait.

Turn outcomes — outputs of `TurnActive`, not deliveries:

| Outcome                                      | Effect on state                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| raises `{approvals*, questions*}`            | append an ApprovalBatch (mixed membership allowed)                        |
| raises challenges                            | append an AuthGroup                                                       |
| hits the budget gate                         | open `Limit(gen)`                                                         |
| dispatches runtime actions alongside a batch | both persist; every HITL request is exposed before dispatching or waiting |
| completes / fails / cancelled                | closure inputs to open groups                                             |

Child events (parent side): child raises a request, child closes a request,
route becomes unusable.

Guard axes — parameters of transitions, not new inputs: the actor relation
(originating / other / anonymous), the candidate identity, and timing (which
is fully encoded by obligation state).

### Interpretation

One pure function interprets every delivery:

```text
interpret(groups, routes, delivery) -> (transitions, events, turnPlan)
```

Drivers schedule; they never interpret. Invariants:

1. **Obligations are data.** No blocked continuation anywhere. The scheduler
   is always receptive.
2. **One arrival-ordered delivery stream.** Callbacks, messages, responses,
   and controls surface in one order; interpretation order is deterministic
   by construction, including under workflow replay.
3. **Single winner per obligation.** Later candidates are stale events.
4. **Continuations fire at most once,** and never on forced closure.
5. **No silent consumption.** Every admitted delivery yields at least one
   observable event: `message.received`, a settlement, a rejection, a
   dismissal, or an authorization event. Every admitted delivery also
   initiates a turn: when responses settle nothing, the turn input is the
   event context — who attempted what, and why it did not settle — so the
   agent can respond in-channel. Retries of the same delivery are
   deduplicated at admission and do not start additional turns.
6. **Composite states add no cases.** The transition catalog for a session
   with approvals _and_ challenges open is the row-wise union of the
   catalogs for each alone. If a change ever needs a case that is not such a
   union, the encapsulation is broken. This is the standing review test for
   any future HITL change.

A channel that renders requests as text — SMS, a comment thread — may map an
explicit reply to a structured response in its adapter, because it knows which
prompt the user saw and which reply targets it. That mapped reply is a
response with full attribution, identical to a button click. The runtime
contract stays structured-only. Future work: an opt-in NLU step may classify a
plain reply into a structured response; its input is restricted to the
verified sender's message and the rendered request — never the agent's ambient
context, so injected tool output cannot forge consent.

## API changes

### Target stream events

The following is the end-state vocabulary that replaces the temporary
`approval.candidate` / `approval.settled` overlay above. Events are the
observable trace of transitions — one vocabulary, not two:

| Transition                                                                            | Event                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| obligation opens                                                                      | `input.requested` / `authorization.required`             |
| candidate accepted, obligation settles                                                | `input.responded`                                        |
| candidate rejected (invalid, stale, unauthorized, policy-failed, candidate-cancelled) | `input.response.rejected`                                |
| candidate parked on separate authorization                                            | `input.response.pending(reason: authorization-required)` |
| obligation dismissed (superseded, cancelled, session-ended, route-lost)               | `input.dismissed`                                        |
| challenge completes                                                                   | `authorization.completed`                                |
| callback after completion                                                             | `authorization.callback.rejected(reason: stale)`         |

All input lifecycle events identify one obligation:

```ts
type InputLifecycleData = {
  requestId: string;
  scope: "owner" | "projection";
  sequence: number;
  stepIndex: number;
  turnId: string;
};

type InputResponseLifecycleData = InputLifecycleData & {
  candidateId: string;
  responder: {
    authenticator: string;
    issuer?: string;
    principalId: string;
  } | null;
};

type InputRespondedData = InputResponseLifecycleData & {
  response: InputResponse;
  outcome: "allowed" | "cancelled" | "answered" | "continued" | "stopped";
};

type InputResponseRejectedData = InputResponseLifecycleData & {
  reason: "invalid" | "stale" | "unauthorized" | "policy-failed" | "candidate-cancelled";
};

type InputResponsePendingData = InputResponseLifecycleData & {
  authorizationId: string;
  reason: "authorization-required";
};

type InputDismissedData = InputLifecycleData & {
  reason: "superseded" | "cancelled" | "session-ended" | "route-lost";
};
```

Authorization lifecycle events carry one `authorizationId`, the verified actor
or null, and the blocked operation identity. `authorization.required`, its
callback, and `authorization.completed` use that ID.

### Wire compatibility

The contract is implementable without breaking any existing consumer. The
rules, in order of strictness:

**Unchanged — guaranteed.** No existing event type changes shape or meaning:
`input.requested`, `message.received`, `session.waiting`, `action.result`,
`turn.*`, and `session.*` stay byte-compatible. `InputRequest` and
`InputResponse` wire shapes are unchanged. The HTTP API gains no new required
field on create, continue, stream, or cancel. Continuation tokens, session
IDs, and NDJSON framing are untouched.

**Additive — new events and fields only.** All net-new wire schema lands in
one stage (lifecycle events) behind one stream-version bump. Existing clients
ignore unknown event types — the default reducer returns state unchanged
([`message-reducer.ts`](../packages/eve/src/client/message-reducer.ts#L286-L287))
— so old clients render nothing new but never break. `authorizationId` is an
optional added field on existing authorization events. `cancelled` is an
additive `AuthorizationOutcome` value.

**One settlement family.** The shipped `approval.settled` event covers the
current approval coordinator. The target `input.responded` family generalizes
that terminal settlement to every request kind; it replaces rather than
competes with `approval.settled`. Exactly one terminal settlement family may
exist on the wire after the lifecycle-event stage.

### Durable state

**Durable state.** The pending-batch collection shipped in [#1868] with a
read shim for the legacy singleton key. The approval coordinator now persists
candidate records, terminal candidate history, and one settlement record per
request in its own durable state. Limit generations and AuthGroups remain
future store work and use the documented snapshot versioning convention.
Legacy `deferredStepInput` content — messages wedged behind an approval before
the mitigation — releases as an ordinary message turn on the first delivery
after upgrade.

### Transport

**Transport consolidation — deliberately breaking, scoped.** The dedicated
authorization hook (`${sessionId}:auth`) is a transitional artifact of the
removed exclusive wait: callbacks are already payload-discriminated
(`authorizationCallback`) and classified at the turn step, so the end state
delivers them through the session's one command stream and deletes the
window-gating machinery. Cost: challenge URLs minted before the cutover embed
the old hook token and would 404; ship either a one-release token alias or
accept the break for in-flight challenges under the pre-1.0 policy.

### Behavior break

**Deliberately breaking, behavior not wire.** Runtime text matching is
removed: plain `approve` stops settling approvals through the resolution path
(`owner.approval.message.run-open`). `resolveTextToResponses` remains exported
for channel adapters that render prompts as text and own their reply mapping.
Documented behavior change (`docs/tools/human-in-the-loop.md`), shipped with
its docs update in the same stage.

## Data flow

Every label below names one construct; target-state constructs are marked.

| Label          | Construct                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| channel POST   | `POST /eve/v1/session/:id` in the [eve channel](../packages/eve/src/public/channels/eve.ts)                                            |
| callback route | [`handleConnectionCallbackRequest`](../packages/eve/src/runtime/connections/callback-route.ts)                                         |
| inbox          | [`SessionCommandInbox`](../packages/eve/src/execution/session-command-inbox.ts)                                                        |
| driver         | [`runDriverLoop`](../packages/eve/src/execution/workflow-entry.ts)                                                                     |
| turn step      | [`turnStep`](../packages/eve/src/execution/workflow-steps.ts)                                                                          |
| interpreter    | `interaction/interpret.ts` (target; today split across `resolvePendingInput`, stale conversion, limit resolution, callback extraction) |
| store          | `interaction/obligations.ts` (target; today pending batches, approval audit state, `pendingAuthorization`, and the limit-prompt batch) |
| executor       | tool-loop transcript assembly, tool execution, model calls                                                                             |

### Call graph

Arrows are calls; annotations are the data crossing the edge.

```text
channel POST ──channel auth──▶ resumeHook ──DeliverPayload──────────▶ inbox
callback route ──param projection──▶ resumeHook ──authorizationCallback──▶ inbox   (stage 4)
inbox ──SessionInboxPayload──▶ driver ──admit / dispatch──▶ turn step
turn step ──(store.read(), delivery)──▶ interpreter ──plan──▶ turn step
plan.transitions ──▶ store            (the only writer of obligation state)
plan.events ──────▶ events.emit ──▶ stream
plan.turnPlan ────▶ executor          (restore output | run tools | model turn)
turn outcome ──new requests / challenges──▶ store.append ──▶ events.emit(input.requested)
```

The driver never sees obligation state; the interpreter never performs a side
effect; the store never decides. Today each of those sentences is false in at
least one module — see [Consolidation](#consolidation-one-interpreter).

### Canonical walks

Data at each step for the three flows that historically wedged or clobbered.

**Message while an approval is open** (`owner.approval.message.run-open`):

```text
delivery         = Message(actor B, "what's the status?")
store.read()     = groups: [Batch{ A1: open }]
interpret        ⊢ no correlated candidate; not limit-gated
plan.transitions = []                          // A1 untouched
plan.events      = [message.received]
plan.turnPlan    = [model-turn(message)]       // model runs WITHOUT the withheld output
store after      = groups: [Batch{ A1: open }] // still answerable
```

**Late accepted response** (`owner.approval.response.settle-allow-after-turns`):

```text
delivery         = Responses(actor A, [{ requestId: A1, optionId: allow }])
store.read()     = groups: [Batch{ A1: open }, withheldOutput W]
interpret        ⊢ candidate c = {A1, deliveryId}; policy accepts; A1 is the last open member
plan.transitions = [settle(A1, allowed), close(Batch)]
plan.events      = [input.responded(A1, c, responder A)]
plan.turnPlan    = [restore W, run tool(call-1) once, resume model]
store after      = groups: []
```

**Authorization callback** (`owner.auth.callback.complete`):

```text
delivery         = Callback("weather", { code })
store.read()     = groups: [AuthGroup{ C1: open }]
interpret        ⊢ C1 matches; completes(authorized); last member closes the group
plan.transitions = [complete(C1, authorized), close(AuthGroup)]
plan.events      = [authorization.completed(C1)]
plan.turnPlan    = [re-drive blocked turn with the callback result]
store after      = groups: []
```

A stale variant of any walk changes exactly one line: `interpret` finds no
open obligation, `plan.transitions = []`, and `plan.events` carries the
rejection — the turn still runs with the stale-attempt context.

## Transition catalog

Normative behavior, one entry per transition row. Anchors are stable
identifiers of the form `machine.obligation.input.outcome[-guard]`; evals and
implementation reference anchors, never positions. `Observed` lists required
events and their relative order; ordinary turn events may appear between them
unless the entry says the sequence is exact.

### owner.approval

#### owner.approval.response.settle-allow

- **Given:** an approval is open.
- **When:** the originating actor sends an explicitly correlated Allow
  response that the tool's response policy accepts.
- **Then:** the approval settles as allowed and the tool becomes eligible. The
  tool runs only when this settlement closes its group.
- **Observed:** `input.responded` precedes `action.result`.

#### owner.approval.response.settle-allow-other-actor

- Same as `settle-allow` with the current actor ≠ originating actor and the
  policy accepting them. The result is identical except the verified
  responder.

#### owner.approval.response.settle-allow-anonymous

- Same as `settle-allow` when the channel supplies no verified principal: eve
  treats the session as one actor for origin comparison and reports
  `responder: null`. The fallback never fabricates a verified principal for
  response policy.

#### owner.approval.response.settle-allow-after-turns

- **Given:** an approval is the last open member of its group and unrelated
  turns completed since it was created.
- **When:** an authorized actor sends an accepted response.
- **Then:** eve restores the group's withheld output once, settles the
  approval, and runs the approved tool once. Intervening turns are unchanged.
- **Observed:** the restored assistant output follows the intervening turns in
  history; the obligation is no longer open.

#### owner.approval.candidate.coalesce-responder

- **Given:** an authorizer-backed approval is open and one responder already
  has an active candidate.
- **When:** that responder submits another Approve before its candidate becomes
  terminal.
- **Then:** eve retains the existing candidate and opens neither a second
  authorizer run nor a second authorization challenge.
- **Observed:** one `approval.candidate(outcome: pending)` for the responder
  and no duplicate terminal event.

#### owner.approval.candidate.open-distinct-responders

- **Given:** an authorizer-backed approval is open.
- **When:** two distinct authenticated responders submit Approve before either
  candidate reaches a terminal result.
- **Then:** eve retains one active candidate for each responder. Their
  authorizer and authorization lifecycles are independent until one settles
  the shared approval.
- **Observed:** two pending candidate events with distinct `candidateId` and
  responder identity.

#### owner.approval.candidate.reject

- **Given:** an authorizer-backed approval is open.
- **When:** its response authorizer returns `{ status: "rejected" }`.
- **Then:** that candidate becomes rejected, the approval remains open, and no
  tool runs.
- **Observed:** one `approval.candidate(outcome: rejected)` and no
  `approval.settled`.

#### owner.approval.candidate.fail

- **Given:** an authorizer-backed approval is open.
- **When:** its response authorizer throws or exceeds its timeout.
- **Then:** that candidate becomes failed, the approval remains open, and no
  tool runs.
- **Observed:** one `approval.candidate(outcome: failed)` and no
  `approval.settled`.

#### owner.approval.candidate.expire

- **Given:** an authorizer-backed approval has an active candidate whose
  deadline passes.
- **When:** eve next coordinates the approval state.
- **Then:** that candidate becomes timed out, the approval remains open, and a
  later Approve may create a fresh candidate.
- **Observed:** one `approval.candidate(outcome: timed-out)` and no
  `approval.settled`.

#### owner.approval.response.settle-cancel

- **Given:** an approval is open.
- **When:** an authenticated actor sends an explicit correlated Cancel.
- **Then:** the approval settles as cancelled and the tool does not run.
- **Observed:** `input.responded(outcome: cancelled)` appears once;
  `action.result` contains `{ code: "TOOL_EXECUTION_CANCELLED", approval:
{ requestId, status: "cancelled" }, tool: { result: "not_run" } }`.

#### owner.approval.response.settle-cancel-pending-candidate

- **Given:** an authorization-required Allow candidate is pending
  (`response.pend-authorization`).
- **When:** an authenticated Cancel settles the approval before the candidate's
  callback, then the callback arrives.
- **Then:** Cancel closes the challenge and the approval; the later callback is
  stale; the tool does not run and the approval does not reopen.
- **Observed:** `authorization.completed(outcome: cancelled)` precedes the one
  terminal `input.responded(outcome: cancelled)`; the later callback emits
  `authorization.callback.rejected(reason: stale)` with the same
  `authorizationId` and `candidateId`.

#### owner.approval.candidate.callback-rerun-authorizer

- **Given:** an authorization-required candidate is pending.
- **When:** its matching callback completes successfully.
- **Then:** eve re-runs that candidate's response authorizer with the same
  responder and candidate identity; it may settle, reject, fail, or request
  authorization again.
- **Observed:** `authorization.completed(candidateId)` precedes the resulting
  candidate or settlement event.

#### owner.approval.response.settle-race

- **Given:** an approval is open and two terminal candidates race — an allowed
  responder vs authenticated Cancel, or two allowed responders.
- **Then:** exactly one terminal outcome wins; the loser is stale. The tool
  runs at most once and only when Allow wins and the group closes.
- **Observed:** exactly one `input.responded`; the loser emits
  `input.response.rejected(reason: stale)`.

#### owner.approval.candidate.stale-after-winner

- **Given:** an approval has two active candidates.
- **When:** one candidate settles the approval.
- **Then:** eve archives every competing candidate as stale and neither a
  callback nor later authorizer work for a loser can execute the tool.
- **Observed:** the winner has one `approval.settled`; each loser has one
  `approval.candidate(outcome: stale)`.

#### owner.approval.response.reject-stale

- **Given:** an approval is no longer open but its owner session is active.
- **When:** any actor sends a response referencing its request ID — including
  a byte-identical duplicate of the winning response arriving as a new
  delivery.
- **Then:** eve changes no obligation and runs no tool. The agent initiates a
  turn with the stale-attempt context.
- **Observed:** `input.response.rejected(reason: stale)`, then model output,
  then `session.waiting`; no second tool execution.

#### owner.approval.response.reject-unauthorized

- **Given:** an approval is open.
- **When:** a correlated response arrives and the response policy rejects the
  responder.
- **Then:** the approval remains open and the tool does not run. The agent
  initiates a turn with the rejection as context — for example, telling the
  responder who may approve.
- **Observed:** `input.response.rejected(reason: unauthorized)` with the
  verified responder, then a normal turn's model output, then
  `session.waiting`. No settlement or dismissal.

#### owner.approval.response.reject-policy-failed

- **When:** a correlated Allow candidate reaches a response policy that throws
  or times out — infrastructure failure, not adjudication.
- **Then:** the approval remains open; the agent initiates a turn with the
  failure context so it can tell the responder to retry.
- **Observed:** `input.response.rejected(reason: policy-failed)`, then model
  output, then `session.waiting`; no terminal event.

#### owner.approval.response.reject-invalid

- **When:** a correlated response carries an unknown option ID or malformed
  value.
- **Then/Observed:** as `reject-policy-failed` with
  `input.response.rejected(reason: invalid)`.

#### owner.approval.response.pend-authorization

- **When:** an Allow candidate requires a separate authorization flow.
- **Then:** eve keeps a durable pending candidate bound to
  `{ candidateId, requestId, responder }`. The approval remains open and the
  tool does not run. The agent initiates a turn with the
  pending-authorization context while the candidate waits. Duplicate delivery
  of the same `candidateId` returns the existing pending candidate and never
  opens a second challenge.
- **Observed:** `input.response.pending(reason: authorization-required)` opens
  a challenge linked to that candidate. After that challenge completes:
  `authorized` re-runs the response authorizer and emits `input.responded`,
  `input.response.pending`, or `input.response.rejected` from that result;
  `declined` → `rejected(unauthorized)`; `failed`/`timed-out` →
  `rejected(policy-failed)`; `cancelled` → `rejected(candidate-cancelled)`.

#### owner.approval.message.run-open

- **Given:** an approval is open.
- **When:** any actor sends a message — including a message whose text
  resembles an option, like the plain word `approve`.
- **Then:** the approval remains open and owned. The message runs as a normal
  turn. The runtime never matches message text against open obligations; if
  the text was in fact an answer, the agent handles it semantically and can
  tell the actor how to actually respond.
- **Observed:** `message.received`, model output, `session.waiting`; no
  request event of any kind.

#### owner.approval.message.no-retroactive-binding

- **Given:** a message arrived before an approval was created.
- **When:** the buffered message is processed after the approval exists.
- **Then:** eve does not interpret the older message as a response to the
  newer obligation. The message runs as a normal turn; the approval stays
  open.

#### owner.approval.compound.settle-then-run

- **Given:** an approval is the last open member of its group.
- **When:** one delivery contains an accepted response plus a message.
- **Then:** eve settles the approval and runs the message as a normal turn;
  each part is processed exactly once.
- **Observed:** serialized: `input.responded`, restored group output, group
  `action.result` events, resumed assistant output, then `message.received`.

#### owner.approval.compound.settle-then-run-siblings-open

- Same delivery, but the group has other open members.
- **Then:** the approval settles, the message runs, the group's withheld
  output stays withheld and no group tool runs yet.
- **Observed:** `input.responded` precedes `message.received`; the group's
  `action.result` is absent.

#### owner.approval.compound.reject-stale-then-run

- **Given:** an approval is no longer open.
- **When:** one delivery contains a response for it plus a message.
- **Then:** eve rejects the stale candidate and runs the message as a normal
  turn; no obligation changes and no stale tool runs.
- **Observed:** `input.response.rejected(reason: stale)` precedes
  `message.received`.

### owner.question

#### owner.question.response.settle-answer

- **When:** an actor sends a correlated answer accepted by the question's
  response policy.
- **Observed:** `input.responded(outcome: answered)` closes only that
  question.

#### owner.question.response.reject-stale

- **Given:** a question is no longer open but its owner session is active.
- **When:** an actor sends a response referencing its request ID.
- **Then:** eve changes no obligation. The agent initiates a turn with the
  stale-attempt context.
- **Observed:** `input.response.rejected(reason: stale)`, then model output,
  then `session.waiting`; no question result is replayed.

#### owner.question.message.dismiss-superseded

- **Given:** a question is open and its tool declares that the originating
  actor may supersede it with a follow-up.
- **When:** the originating actor sends a message.
- **Then:** the question is dismissed as superseded; the message runs as a
  normal turn. If the message was in fact the answer typed as text, the agent
  handles it semantically — the runtime does not guess.
- **Observed:** `input.dismissed` precedes `message.received`.

#### owner.question.message.run-open-other-actor

- **When:** a non-originating actor sends a message.
- **Then:** the question remains open; the message runs as a normal turn.
- **Observed:** `message.received` and no closure event for the question.

#### owner.question.compound.settle-then-run

- **When:** one delivery contains an accepted answer plus a message.
- **Then:** the answer settles the question; supersession does not run; the
  message runs after any closing group work.
- **Observed:** `input.responded` precedes `message.received`.

### owner.batch

#### owner.batch.response.settle-partial

- **Given:** one assistant turn created a group with multiple open members.
- **When:** an accepted response settles one member while siblings remain
  open.
- **Then:** the answered member is settled; siblings remain open; the withheld
  output is not restored and no group tool runs.
- **Observed:** the group remains pending and the withheld output appears zero
  times in committed history.

#### owner.batch.close.fire-continuation

- **Given:** one member remains open in a group.
- **When:** it settles, or is superseded while its owner remains runnable.
- **Then:** eve restores the withheld output exactly once, appends every
  member outcome, and runs each allowed tool exactly once.
- **Observed:** each tool call, response, and tool result appears exactly
  once.

#### owner.batch.message.dismiss-question-only

- **Given:** one group contains an approval and a question.
- **When:** the originating actor supersedes the question.
- **Then:** only the question is dismissed. The withheld output stays withheld
  until the approval also closes.
- **Observed:** `input.dismissed` names the question only; the approval
  remains open in the same group.

#### owner.batch.park.append

- **Given:** an earlier group still has open members.
- **When:** a later turn parks with its own requests.
- **Then:** both groups remain independently addressable; closing one does not
  change or replay the other.
- **Observed:** `input.requested` exposes every new request ID exactly once.

#### owner.batch.park.persist-with-runtime-action

- **Given:** one assistant turn creates HITL requests and starts a subagent or
  remote action.
- **Then:** eve persists both the group and the runtime action, and exposes
  every request before dispatching or waiting. No approval disappears behind
  the runtime action.
- **Observed:** `input.requested` appears exactly once for every request.

#### owner.batch.park.fail-closed-metadata

- **Given:** a nonautomatic approval exists but eve cannot recover the
  matching tool-call metadata needed for `InputRequest`.
- **Then:** eve fails the turn explicitly instead of executing the tool,
  dispatching sibling actions, or waiting on a hidden approval.
- **Observed:** `step.failed(code: HITL_REQUEST_METADATA_MISSING)` precedes
  `turn.failed` and `session.failed`; `session.waiting` is absent.

#### owner.batch.forced-close.no-continuation

- **Given:** a group has open members.
- **When:** cancellation or session termination dismisses them.
- **Then:** eve does not restore the withheld output and runs no group tool or
  model call.
- **Observed:** `input.dismissed` events precede the cancellation or terminal
  session event.

### owner.limit

#### owner.limit.message.supersede

- **Given:** a limit prompt is visible and the limit still applies.
- **When:** any actor sends a message without granting continuation.
- **Then:** eve dismisses the old prompt as superseded, opens a fresh prompt
  with a new request ID from the monotonic generation, and does not call the
  model. The triggering message is consumed by the limit check and is not
  replayed later.
- **Observed:** `input.dismissed(old)` precedes `input.requested(new)`; the
  message is not hidden in deferred input.

#### owner.limit.response.settle-continue

- **When:** the actor sends the correlated Continue response.
- **Then:** the prompt settles, a fresh budget window opens, and any
  co-delivered message is processed.
- **Observed:** `input.responded` precedes `message.received` when a message
  is present.

#### owner.limit.response.settle-stop

- **When:** the actor sends the correlated Stop response.
- **Then:** the prompt settles and the active turn is cancelled; no model
  call.
- **Observed:** `input.responded` precedes `turn.cancelled`; the session
  remains resumable afterward.

#### owner.limit.response.reject-stale

- **Given:** prompt generation `gen` was superseded by `gen+1`.
- **When:** a Continue or Stop response references `gen`.
- **Then:** no budget changes and the turn is not cancelled.
- **Observed:** `input.response.rejected(reason: stale)` references the old
  prompt; the fresh prompt remains open.

### owner.auth

#### owner.auth.message.run-open

- **Given:** a challenge is open with an `authorizationId` bound to its actor
  and blocked operation.
- **When:** any actor sends a message.
- **Then:** the challenge remains open; the message runs as a normal turn.
- **Observed:** `message.received` and no `authorization.completed`.

#### owner.auth.callback.complete

- **When:** a callback carrying an open challenge's `authorizationId`
  resolves.
- **Then:** eve emits `authorization.completed` with the actual outcome:
  `authorized` resumes the blocked operation (via the AuthGroup continuation
  when the last member completes); `declined` emits an authorization-declined
  `action.result` and lets the model continue; `failed`/`timed-out` emit the
  corresponding failed `action.result` and let the model continue;
  `cancelled` follows the cancellation boundary.
- **Observed:** callback receipt alone is not completion. Required, callback,
  and completed events share one `authorizationId`.

#### owner.auth.callback.reject-stale

- **Given:** a challenge already completed — by callback, deadline, or
  closure — or no matching challenge is open.
- **When:** a callback arrives.
- **Then:** eve resumes nothing and changes no state.
- **Observed:** `authorization.callback.rejected(reason: stale)` with the
  challenge's `authorizationId` when one existed. A callback with no matching
  challenge is rejected the same way, never silently queued.

#### owner.auth.deadline.complete-timed-out

- **When:** a challenge's deadline passes before its callback.
- **Then:** the challenge completes as timed-out; eve does not resume blocked
  work.
- **Observed:** exactly one `authorization.completed(outcome: timed-out)`.

#### owner.auth.close.complete

- **When:** the owning turn is cancelled or the session ends while a challenge
  is open.
- **Then:** turn cancellation, session completion, and explicit termination
  map to `cancelled`; session failure maps to `failed`.
- **Observed:** exactly one `authorization.completed` with that outcome.

### owner cancellation

#### owner.obligation.turn-cancel.dismiss

- **Given:** the owner session has open obligations created by multiple turns.
- **When:** one owning turn is cancelled.
- **Then:** eve dismisses only obligations bound to the cancelled turn; others
  remain open.
- **Observed:** every `input.dismissed(reason: cancelled)` precedes
  `turn.cancelled`.

#### owner.obligation.session-end.dismiss

- **When:** the session completes, fails, times out, or is terminated with
  open obligations.
- **Then:** every open owned obligation is dismissed as session-ended.
- **Observed:** every `input.dismissed(reason: session-ended)` precedes the
  terminal session event.

### scheduler

#### scheduler.delivery.admit-arrival-order

- **Given:** deliveries arrive while a turn is active.
- **When:** the turn reaches a receptive boundary.
- **Then:** eve admits the buffered deliveries exactly once in durable arrival
  order. Each delivery is interpreted against the state produced by the
  preceding one.
- **Observed:** their `message.received` and resulting transition events retain
  arrival order.

#### scheduler.delivery.admit-actor-partition

- **Given:** buffered deliveries arrive from actor A, then B, then A.
- **When:** eve drains them.
- **Then:** three ordered actor-homogeneous turn inputs; no merging across
  actor boundaries.
- **Observed:** each `message.received` is evaluated with its own verified
  actor and durable arrival order.

### projector

#### projector.route.park.project

- **When:** a child session creates a HITL request and the parent receives it.
- **Then:** the child remains the owner; the parent exposes an actionable
  copy.
- **Observed:** the parent stream re-emits `input.requested` with the same
  request ID.

#### projector.route.close.project

- **When:** the child settles or dismisses a projected request.
- **Then:** the parent re-emits the closure with `scope: projection` and drops
  only that request's route. Sibling routes remain active.

#### projector.route.drop.route-lost

- **When:** the parent's route to a child request becomes unusable, or the
  parent session ends with active routes.
- **Then:** the parent dismisses only its projected copies as route-lost. It
  never claims the child requests settled.
- **Observed:** `input.dismissed(scope: projection, reason: route-lost)`
  precedes route removal or the parent terminal event.

#### projector.route.response.reject-stale-after-drop

- **Given:** a route still exists but the child's continuation hook has been
  disposed.
- **When:** a response reaches that route before cleanup.
- **Then:** eve does not resume the child, fail the parent, mutate another
  obligation, or call the model. The route closes as route-lost.
- **Observed:** `input.dismissed(scope: projection, reason: route-lost)`, then
  `input.response.rejected(scope: projection, reason: stale)`;
  `session.failed` is absent.

#### projector.route.response.forward-responder

- **When:** an actor responds through the parent channel to a child-owned
  request.
- **Then:** the parent forwards the verified responder unchanged; the child
  evaluates its own response policy. If the child emits
  `input.response.pending`, the parent projects that event and the matching
  authorization events with unchanged `candidateId` and `authorizationId`;
  the callback route remains child-owned.
- **Observed:** the child outcome is re-emitted by the parent without
  substituting the parent actor.

#### projector.route.response.reject-unauthorized-remote

- **When:** a remote child rejects the forwarded principal or responder proof.
- **Then:** eve fails closed: the request stays open, no remote tool runs.
- **Observed:** the parent re-emits
  `input.response.rejected(scope: projection, reason: unauthorized)`; no
  terminal request event.

## Implementation state and staging

Shipped by the mitigations, with their deliberate deviations from this
contract:

- **Always-receptive scheduler** — [#1830] (authorization; via a window-gated
  extra inbox source, superseded by the transport consolidation above) and
  [#1868] (approvals). The two blocked continuations are gone.
- **Group collection** — [#1868] stores pending batches as an ordered list
  with a legacy-key read shim. Deviations to replace: partial responses are
  deferred rather than settled per-member
  (`owner.batch.response.settle-partial`); text matching is retained
  (`owner.approval.message.run-open`); question supersession is not
  actor-scoped (`owner.question.message.run-open-other-actor`); multi-batch
  question dismissal is suppressed rather than per-group.
- **Authorized approval responses** — this stack persists responder-bound
  candidates, runs response authorizers, binds authorization challenges to a
  candidate, atomically settles Allow/Cancel races, and projects the resulting
  lifecycle events from subagents. It intentionally remains a separate
  coordinator (`harness/approval-delivery-coordinator.ts`) until candidate
  state, authorization, and request groups move into `interaction/`.

### Consolidation: one interpreter

The complete machine above is not yet implemented in one place. The approval
coordinator is a durable state machine, but interpretation across requests,
batches, challenges, limits, and routes is still smeared across ten modules.
That dispersion is why both wedges could exist — no single seam sees the whole
state.

| Fragment                                         | Today lives in                                                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| batch resolution, defer decisions                | [`harness/input-requests.ts`](../packages/eve/src/harness/input-requests.ts)                                                                                                                             |
| batch + deferred-input storage                   | [`harness/pending-input-batches.ts`](../packages/eve/src/harness/pending-input-batches.ts)                                                                                                               |
| stale-response conversion (a second interpreter) | [`harness/stale-input-responses.ts`](../packages/eve/src/harness/stale-input-responses.ts)                                                                                                               |
| required/dismissable classification              | [`harness/input-request-class.ts`](../packages/eve/src/harness/input-request-class.ts)                                                                                                                   |
| limit prompt creation + resolution special cases | [`harness/session-limit-enforcement.ts`](../packages/eve/src/harness/session-limit-enforcement.ts), [`harness/session-limit-continuation.ts`](../packages/eve/src/harness/session-limit-continuation.ts) |
| approval candidate coordination                  | [`harness/approval-candidates.ts`](../packages/eve/src/harness/approval-candidates.ts), [`harness/approval-delivery-coordinator.ts`](../packages/eve/src/harness/approval-delivery-coordinator.ts)       |
| challenge storage + callback pairing             | [`harness/authorization.ts`](../packages/eve/src/harness/authorization.ts), [`execution/workflow-steps.ts`](../packages/eve/src/execution/workflow-steps.ts)                                             |
| callback wait scheduling                         | [`execution/workflow-entry.ts`](../packages/eve/src/execution/workflow-entry.ts), window gating in [`execution/session-command-inbox.ts`](../packages/eve/src/execution/session-command-inbox.ts)        |
| projection routing                               | [`harness/proxy-input-requests.ts`](../packages/eve/src/harness/proxy-input-requests.ts), [`execution/subagent-hitl-proxy.ts`](../packages/eve/src/execution/subagent-hitl-proxy.ts)                     |
| text matching in the resolution path             | [`channel/resolve-text.ts`](../packages/eve/src/channel/resolve-text.ts) via input-requests                                                                                                              |
| forced-closure sweeps                            | [`execution/settle-cancelled-turn-step.ts`](../packages/eve/src/execution/settle-cancelled-turn-step.ts)                                                                                                 |

Target shape — one harness-owned package implements the machine; everything
else is an adapter that feeds it inputs or executes its plans:

```text
harness/interaction/
  obligations.ts   one durable store: groups (batches, auth groups, limit
                   prompts), candidates, generations; the only writer of
                   obligation state
  interpret.ts     the pure function: (groups, routes, input) -> plan
                   where input = delivery | timer | turn outcome | child event
                   and plan = { transitions, events, turnPlan }
  projector.ts     routes: project / forward / re-emit / drop
  events.ts        transition -> wire event emission
```

Adapters after consolidation:

- **tool-loop**: park = append a group; step start = execute the plan.
  Replaces `resolvePendingInput`, the stale-conversion pass, the limit
  special cases, and the deferral _decisions_. The AI SDK constraint that an
  approval response resolves in isolation becomes an ordered `turnPlan`, not
  a hidden state key.
- **workflow-steps**: callback extraction and `authorization.completed`
  emission become `interpret(Callback)`; `derivePendingState` reads the one
  store.
- **workflow-entry**: pure scheduler. The window machinery
  (`claimAuthorization`, `setAuthorizationWindow`, `nextWithSource`,
  `awaitAuthorizationResume`) is deleted by the transport consolidation;
  callbacks arrive through the one command stream and are classified by
  payload, which the turn step already does.
- **session-limit-enforcement**: the budget gate opens a `Limit(gen)`
  obligation in the store; resolution is an interpret row like any other.
- **proxy modules**: fold into `projector.ts`.
- **resolve-text**: leaves the runtime path; stays exported for channel
  adapters.

Deleted outright: `stale-input-responses.ts` (becomes the `reject-stale`
rows), `input-request-class.ts` (classification is the obligation kind), the
inbox window machinery, and `deferredStepInput` as a decision mechanism — it
survives at most as plan persistence across internal steps.

### Stages

Each lands alone with its own gate; after stage 4, every remaining contract
behavior is a diff to `interpret.ts` and its unit matrix.

1. **Store extraction.** `obligations.ts` unifies pending batches, the
   existing approval audit state, `pendingAuthorization`, and the limit prompt
   into one shape, with generations. It preserves the coordinator's active
   candidates, terminal history, and settlement records; read shims cover both
   legacy keys.
2. **Interpreter extraction.** `interpret.ts` absorbs `resolvePendingInput`,
   stale conversion, and limit resolution, behavior-preserving; the existing
   unit matrices move with it. Text matching enters as an explicit,
   removable rule.
3. **Auth through the machine.** Challenge parks become AuthGroups in the
   store; callback extraction becomes `interpret(Callback)`; the deadline
   becomes a timer input (today it has no producer). Multi-challenge resume
   falls out of group closure.
4. **Transport and routing.** Callbacks through the command stream (window
   machinery deleted; in-flight challenge-URL cost per Compatibility);
   projector extraction with per-request route accumulation (fixes #1608);
   actor-partitioned coalescing.
5. **Behavior completion, inside the interpreter.** Per-member settlement
   replacing defer-partials; actor-scoped question supersession; text-match
   removal with its docs update; fail-closed request creation (fixes #1201);
   limit re-prompt closure.
6. **Lifecycle events + eval matrix.** `events.ts` emits the event family;
   the gated evals
   ([`e2e/fixtures/agent-tools-hitl/evals/lifecycle/`](../e2e/fixtures/agent-tools-hitl/evals/lifecycle/coverage.md))
   activate via `EVE_HITL_LIFECYCLE_CONTRACT=1`, keyed by anchor, with
   expected sequences written literally and never computed from runtime
   code.

The acceptance gate for the late splice —
[`tool-loop-generate-approval-resume.integration.test.ts`](../packages/eve/src/harness/tool-loop-generate-approval-resume.integration.test.ts)
with a normal turn between the approval request and its response — shipped
with [#1868] and passes; provider converters remain the residual risk to
verify against real models.

## Closed when this ships

Fixes [#1224](https://github.com/vercel/eve/issues/1224) — freeform reply to a
pending approval mutes the session forever (behavioral core shipped in
[#1868]).
Fixes [#1201](https://github.com/vercel/eve/issues/1201) — approval silently
dropped when a step also requests a subagent call.
Fixes [#1608](https://github.com/vercel/eve/issues/1608) — duplicate input
response resumes a disposed child hook and fails the parent.

## Related, not closed by this

- [#786](https://github.com/vercel/eve/issues/786) — consumed-as-answer half
  is fixed; mid-turn steering is out of scope.
- [#1095](https://github.com/vercel/eve/issues/1095) — the approval settlement
  event shipped; its generalization to every obligation remains in this plan.
- [#1021](https://github.com/vercel/eve/issues/1021) — responder
  authorization is implemented by this stack; consolidating it into the one
  interpreter remains in scope here.
- [#1658](https://github.com/vercel/eve/issues/1658) — OpenAI provider
  transcript-shape bug; not fixed here.

## Related work

- The authorized approval-response stack: responder identity, authorization,
  Allow, Cancel, candidate lifecycle, and request settlement. Its durable
  coordinator is an input to this plan, not a second end-state interpreter.
- [PR #1231](https://github.com/vercel/eve/pull/1231): makes every message
  replace unresolved input. Replacing another actor's request breaks
  ownership.
- [PR #142](https://github.com/vercel/eve/pull/142): Slack-specific responder
  enforcement.

[#1830]: https://github.com/vercel/eve/pull/1830
[#1868]: https://github.com/vercel/eve/pull/1868
