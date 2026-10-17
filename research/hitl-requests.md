---
issue: "TBD (no tracking issue yet; evidence issues listed under Motivation)"
status: draft
last_updated: "2026-10-02"
---

# HITL requests: transitions in the session machine

## Decision

HITL runs as pure transitions in the session machine. A transition reads the session and an
input, and returns what changes:

```ts
(view: SessionView, input) => Transition { events, turn, commit }
```

The runtime only applies a transition: it publishes `events`, writes `turn` (the execution state),
and appends `commit` to history. Nothing else builds a lifecycle event or writes HITL state. This is
the session machine from #4142, and #4217 implements the HITL part of it on `main`.

Every HITL request holds its turn open, and the answer continues the same turn. A model step that
makes gated calls is suspended: its response stays out of history until every call it made has a
result. eve runs approved calls itself, with the tools of the step that asked, so the AI SDK's
approval parts never enter history. That removes the AI SDK's last-message rule and every guard
built to protect it.

The authoring API does not change. Observable changes from `main`:

- the budget question holds the turn instead of ending it;
- the model is not called while an approval is open, and the `[Pending approvals]` note is gone;
- a typed reply answers whatever it matches (see Typed replies), and the rest keeps waiting;
- cancel emits one `input.resolved` per request.

Line numbers refer to `origin/main` `61813722e` (2026-10-02). Paths in the design refer to #4142
(`owenkephart/session-machine`, `4bb1eae41`). Paths are relative to `packages/eve/src` unless they
start with `research/`.

## Terms

| Term            | Meaning                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| request         | One thing eve asks a person: an approval, a question, a budget question, or a sign-in. Identified by `requestId`           |
| transition      | A pure function from `(SessionView, input)` to a `Transition` (`harness/session-machine/commit.ts`)                        |
| `TurnState`     | The execution state the machine keeps between steps, at `eve.harness.turnState` (`harness/session-machine/state.ts`)       |
| suspended step  | A `SuspendedStep`: a model step whose calls can't all settle yet, held with its withheld response                          |
| projection      | Lifecycle facts (open turns, open requests, sign-ins, call outcomes) folded from every published stream event (#4141)      |
| held turn       | A turn that stays open while it waits on a request or a runtime task (`turn.waiting`, with `on: "input"` or `on: "tasks"`) |
| steering        | A message from the turn's requester that arrives during the turn and is not an answer                                      |
| gated call      | A tool call whose approval policy returns `"user-approval"`, or that asked for a sign-in while it ran                      |
| budget question | The session-limit continuation request, raised before a model call when the session is over budget                         |
| response policy | The tool's answer-time `approval.response`, deciding whether a responder may approve or cancel                             |
| requester       | The caller whose turn parked a step (`SuspendedStep.requester`); `null` when unauthenticated                               |

## Motivation

### How it works today

Since #4135, an approval or a plain tool's sign-in holds the turn: the stream reports `turn.waiting`
with `on: "input"`, and the answer resumes the same turn (`holdTurnForRequest`,
`harness/tool-loop.ts:2852`). A steering message from the person withdraws the held sign-ins
(`withdrawHeldSignIns`, `harness/held-requests.ts`) and resolves the approvals `ignored`
(`harness/input-request-resolution.ts`).

What runs an approved call has not changed. The AI SDK calls eve's `toolApproval` callback during
`generate()` (`harness/tool-loop.ts:1593`), adds an approval part to the call, and runs the call in
a later `generate()` only if the approval response is the last message in history
(`collectToolApprovals` in `ai`). eve holds the waiting call outside history meanwhile, adds a
`[Pending approvals]` note, and writes the call back, followed by the approval response, when the
answer arrives. Plain-tool sign-in removes the interrupted call from history
(`projectCompletedSiblingCalls`, `harness/inline-tool-authorization.ts`). A budget question still
ends the turn (`harness/session-limit-enforcement.ts`).

Each request kind has its own store and its own resume path:

| Store                                                                  | Holds                                                                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `eve.runtime.pendingInputBatches` (`harness/pending-input-batches.ts`) | Approvals and root budget questions, with the held-back call                                                               |
| `eve.runtime.deferredStepInput` (same file)                            | Messages that arrived while a batch was open                                                                               |
| `eve.runtime.hitl.approvalState` (`harness/approval-candidates.ts`)    | Approval answers waiting on the response policy                                                                            |
| `eve.runtime.pendingAuthorization` (`harness/authorization.ts`)        | Plain-tool sign-ins                                                                                                        |
| `eve.runtime.proxyInputRequests` (`harness/proxy-input-requests.ts`)   | `ctx.ask` questions and child requests                                                                                     |
| The workflow run itself (`execution/tools/workflow/step.ts`)           | Sign-ins inside a workflow step. The run waits for the callback on its own hook, and the session only publishes the events |

Each store has its own reader, its own writer, and its own rule for what clears it. The session's
idle check reads them by name before it allows a handoff (`execution/session/handoff-steps.ts`).

### The record

From 2026-08-20 to 2026-09-30:

- **46 HITL issues** were filed, and 27 are still open. They cover tool approvals, `ask_question`
  and `ctx.ask`, budget questions, sign-ins, and how each is relayed, shown, and resumed.
- **About 40 HITL pull requests** were opened. 26 are bot-written fixes, and 20 of those were still
  unmerged on 2026-09-29.
- **87 commits** on `main` touched HITL files: 60 from 08-29 to 09-28, and 27 more by 09-30.
  `harness/tool-loop.ts` was touched by 55 commits since 08-29 and is now 3,355 lines.
- **The same failure keeps coming back.** Seven distinct issues, plus one duplicate, come from a
  message landing after an approval response or next to a waiting call. The approval is dropped, or
  the provider rejects the request and the session ends. Each was fixed with a guard at one site
  (#2656, #2919, #3595, #3903), and the next writer broke it again.

### The issues, by cause

The question for each issue is whether this design prevents it by construction, with no guard or
special case added for it, whether or not it has since been patched on `main`. Of the 46 issues,
29 are prevented and 17 are not.

| Cause                                                                                                                     | Prevented by design                                    | Not prevented                                                                      | Why                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A message lands after the approval response**, so the approval is dropped or the provider rejects a call with no result | #2594, #2699, #2826, #2874, #3594, #3771, #3899, #3943 |                                                                                    | eve runs approved calls itself, and AI SDK approval parts never enter history, so there is no last-message rule to break. A suspended step's response joins history only with a result for every call it made                                                              |
| **Resume loses turn context**: the turn id, the answering principal, turn-scoped connections, or a user message           | #3705, #3760 (and #3771 above)                         |                                                                                    | The answer continues the same turn, and the approved call runs with the asking step's tools                                                                                                                                                                                |
| **Several approvals wait on each other**: one batch resolves per step                                                     | #3494, #3711, #4024                                    |                                                                                    | The model is not called while an approval is open, so only one suspended step has open approvals. Its answers resolve together, and eve runs the approved calls before the model reads their results                                                                       |
| **A message is misread** as an answer, a dismissal, deferred input, or a new turn                                         | #2466, #2469, #3421 (and #2699, #3494, #3711 above)    | #3680, #4035                                                                       | One intake classifies every delivery in one order, and an open approval no longer changes the tools the model is called with (#2466 and #2469). #3680 needs typed replies to answer approvals that have a response policy. #4035 is how free-text questions work           |
| **Pending state is split**, and cancel, steer, or settle clears only part of it                                           | #2421, #2442, #3414, #3458, #3887 (and #2874 above)    |                                                                                    | Execution state is one `TurnState`, and cancel and steer are transitions that withdraw from it. The harness stores where #2442 and #3414 went stale are gone. Each call's sign-in is its own record, so finishing one doesn't re-run a step shared with the others (#2421) |
| **Child and task relays drift** from the root path                                                                        | #2520, #3589, #3784, #3990 (and #3458 above)           | (#3680 above)                                                                      | Relayed requests go through the same intake, settle events, publication path, and "nobody can answer" rule as the turn's own (see Stream events)                                                                                                                           |
| **Events are missing or not reduced**, so clients and channels get stuck                                                  | #3757, #3911 (and #2520, #3705, #3784, #3990 above)    |                                                                                    | Every park emits `turn.waiting`, and approval state has one source, the `input.*` events                                                                                                                                                                                   |
| **Policy and identity gaps**                                                                                              | #3198, #3891                                           | #3238, #3822, #3906                                                                | A gated call runs only after its request is answered, and every park records which requests need the response policy. #3238 is a choice of default, and #3822 and #3906 ask for identity the policy can't see yet                                                          |
| **Outside this design**                                                                                                   |                                                        | #2319, #2471, #2476, #2779, #2806, #2845, #3103, #3497, #3546, #3615, #3712, #3895 | Channel rendering, configuration, durability, budget arithmetic for delegated sessions, scoped approval keys, and packaging                                                                                                                                                |

### Two root causes

The first three rows share one cause: the AI SDK runs an approved call only if the approval
response is the last message. The defenses are `hasTailApprovalResponse`
(`harness/current-messages.ts`, called from `harness/tool-loop.ts:888` and
`harness/workflow-dispatch.ts`) and a preamble reordering whose comment names the constraint ("so
an approval response stays in the final tool message, where the AI SDK reads it"). Every writer of
history had to know the rule.

The rest share the other cause: an open request lives in one of six stores depending on its kind,
each with its own reader, writer, and clearing rule. A fix on one path doesn't reach the others.
#3891 is the clearest case: one park site omitted the response-policy flag, so the policy was
skipped when an approval parked next to a workflow call. #3954 fixed that site, and every new park
site still had to remember the flag.

The session machine removes both. eve runs approved calls, so the tail rule no longer applies to
anything eve writes. And every HITL change is a transition over one view, applied in one place, so
there is one rule per decision instead of one per writer.

## The session machine

### Transitions

The HITL transitions live in `harness/human-input/`; the machine's state, view, and apply live in
`harness/session-machine/`.

| Transition        | Called when                                           | Returns                                                                           |
| ----------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `parkOnApprovals` | A model step made gated calls                         | `input.requested`, and a `SuspendedStep` holding the step's response and requests |
| `answer`          | A delivery reaches the turn                           | Resolutions, `once()` grants, queued leftovers, and what runs next                |
| `requestLimit`    | The session is over budget before a model call        | `input.requested` for the budget question                                         |
| `requireSignIn`   | A call the model step ran needs a sign-in             | `authorization.required`; the calls that need it stop                             |
| `withdrawSignIns` | A steer or cancel ends the sign-ins the turn waits on | `authorization.completed` `declined`, one per open sign-in                        |

Around them:

- **Intake** (`acceptHumanInput`, `harness/human-input/intake.ts`) takes a delivery's answers and
  sign-in callbacks before the turn runs, and decides steering.
- **Coordinator** (`harness/human-input/coordinator.ts`) runs response policies on answers.
- **Candidates** (`harness/human-input/candidates.ts`) keep durable records of response-policy
  answers in `approvalState`: candidates, their history, and settlements.
- **Approved work** (`runApprovedCalls`, `harness/human-input/approved-calls.ts`) runs the calls a
  delivery approved, re-checking each with `recheckApprovedCall` first.

### Where state lives

In the full #4142 stack, lifecycle facts are a projection folded from every published stream event
(#4141). Whether a turn is open, whether a request is answered, and how a call ended are read from
the session log, not stored separately. Only execution data is stored, in `TurnState`:

```ts
interface TurnState {
  queued?: StepInput; // input that arrived before it could run
  suspended: readonly SuspendedStep[];
  grants: readonly string[]; // approval keys a once() approval granted
}

interface SuspendedStep {
  event: StepCoordinates; // sequence, stepIndex, turnId of the step that parked
  messages: readonly ModelMessage[]; // the withheld response; results join it as they arrive
  requests: readonly InputRequest[]; // approvals the step still waits on
  tasks: readonly RuntimeWorkflowTaskRequest[]; // workflow and agent calls the runtime runs
  responseAuthRequiredRequestIds?: readonly string[];
  requester?: SessionAuthContext | null;
}
```

`TurnState` replaces the pending input batches, the coordination batch, the deferred step input,
and `eve.runtime.hitl.approvedTools`. Private records the projection can't hold (relay routes,
sign-in challenges) live only while the projection shows their owner open.

On `main`, #4217 ports the transitions and `TurnState` but not the projection. Until the projection
lands, whether the budget question and relayed requests are open still lives in
`openInputRequests`, and sign-ins in `pendingAuthorization`.

### Owners

The session alone accepts or withdraws an answer. The owner is what continues once it does.

| Owner          | Requests                                                        | Continues on answer                                                                          |
| -------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Turn           | Approval or sign-in for a call the model made; budget question  | eve runs the approved call; the model calls the signed-in tool again; or the model call runs |
| `execute` call | `ask_question`, `ctx.ask`, `requireAuth` inside a workflow body | The call's body, as on `main`                                                                |
| Child session  | Whatever the child raised                                       | The child, which holds its own turn, as on `main`                                            |

| When                                                                | Then                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| An answer or callback arrives for a withdrawn or answered request   | It is stale and changes nothing                                                                |
| Nobody can answer (a schedule, or a session without `requestInput`) | The request resolves `unavailable` at once                                                     |
| A child session raises a request                                    | The child holds its own turn; the request travels up and the answer routes down by `requestId` |

## Approvals

### The usual path

1. The model calls `send_email`. The approval policy returns `"user-approval"`.
2. `parkOnApprovals` suspends the step: its response, including the call, is held in
   `TurnState`, not history. eve emits `input.requested`, and the turn holds (`turn.waiting`,
   `on: "input"`). The model is not called.
3. The person approves. If the tool has a response policy, the coordinator checks who answered.
4. `answer` resolves the request. eve re-checks the call (`recheckApprovedCall`) and runs it with
   the asking step's tools (`runApprovedCalls`), streaming its progress and result.
5. The step's response and the call's result are committed to history together, and the model is
   called.

### Everything else

| What happens                                                                     | Result                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The approval policy returns `"approved"` or `"not-applicable"`                   | The call runs right away, as on `main`                                                                                                                                  |
| The approval policy returns `"denied"`                                           | The call does not run; its result says it was denied                                                                                                                    |
| The person denies                                                                | The call does not run; its result says the person declined                                                                                                              |
| The re-check denies the approved call                                            | The call does not run; its result is `execution-denied` with the re-check's reason                                                                                      |
| The response policy rejects whoever answered (Approve or Cancel, as since #3954) | The request stays open for someone else (`input.candidate` `rejected`)                                                                                                  |
| One step makes several gated calls                                               | One request per call in the same suspended step. Answers that match resolve; the rest keep waiting. Once all are answered, eve runs the approved calls together         |
| The step also made runtime calls (workflow or agent tools)                       | They run as tasks of the suspended step; its response joins history once every call has a result                                                                        |
| The turn's requester steers                                                      | Answered calls keep their answers; unanswered approvals are withdrawn (`input.resolved` `ignored`), their results say they did not run, and the model reads the message |
| The call also needs a sign-in                                                    | The approval comes first; the sign-in only comes up once the approved call runs                                                                                         |
| The turn is cancelled                                                            | Every approval is withdrawn, one `input.resolved` `cancelled` per request; a later answer approves nothing                                                              |

### Walkthrough

Alice asks the agent to email a report.

| #   | What happens                                                      | The model reads                  | The model does                    | Events                                                 |
| --- | ----------------------------------------------------------------- | -------------------------------- | --------------------------------- | ------------------------------------------------------ |
| 1   | Alice: "email the report to Bob"                                  | Her message                      | Calls `send_email`                | `turn.started turn_1`, `actions.requested`             |
| 2   | The policy asks for approval. `parkOnApprovals` suspends the step | Nothing; the model is not called |                                   | `input.requested a1`, `turn.waiting on: "input"`       |
| 3   | Alice clicks Approve. The session accepts the answer              | Nothing yet                      |                                   | `input.resolved a1 approved`                           |
| 4   | eve runs `send_email` and commits the step with its result        | The result: sent                 | Replies "Sent the report to Bob." | `action.result`, `message.completed`, `turn.completed` |

Every event carries `turn_1`.

### How an approval runs

| Stage    | Today                                                                                                                                                             | Under this design                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Decide   | During `generate()`, the AI SDK calls eve's `toolApproval` callback (`buildToolApproval`, `harness/tools.ts`), which runs the tool's policy                       | Unchanged                                                                                                      |
| Ask      | The SDK adds an approval part to the call. eve moves the call out of history into a pending batch, adds a `[Pending approvals]` note, and emits `input.requested` | `parkOnApprovals` holds the step's response in a `SuspendedStep` and emits the same `input.requested`. No note |
| Answer   | The approval coordinator runs the response policy                                                                                                                 | The coordinator runs the response policy; candidates keep durable records in `approvalState`                   |
| Remember | An approved tool is recorded in `eve.runtime.hitl.approvedTools`, which `once()` reads                                                                            | The key goes into `TurnState.grants`. It is hidden while an approval for that key still waits                  |
| Run      | The SDK runs `execute` in the next `generate()`, only if the approval response is the last message                                                                | eve runs the call with `runApprovedCalls`, after `recheckApprovedCall`, with the asking step's tools           |

The built-in policies keep their meaning: `always()` always asks, `never()` never asks, `once()` asks
until the tool has been approved once in the session, and `auto()` asks its evaluation model at the
Decide stage.

`runApprovedCalls` keeps what the SDK path provided: the policy re-check (used for connection
pinning), `toModelOutput`, streamed partial output, nested actions, and sign-in signals. It builds
the tool set from the asking step's tools, so authored, connection, MCP, dynamic, and built-in tools
such as `bash` all run the same way.

## Typed replies

A text message from the turn's requester answers what it matches, by option id, label, or number,
using today's matcher (`channel/resolve-text.ts`):

- **The single answerable step.** When one suspended step has open approvals, the text answers the
  approvals it matches. Partial matches are answered, and the rest keep waiting.
- **The budget question.** "Continue" or "Stop" answers it.
- **A relayed question**, only when it is the only relayed one open and the message is the person's
  own. A question that accepts free text takes any text (#4035).

Text that matches nothing steers. Responses left over once the matching requests are answered are
queued in `TurnState.queued` and run with the next step. Requests with a response policy are not
answered by text, as today (#3680).

At walkthrough row 2, `a1` has options `approve` / "Approve" and `cancel` / "Cancel":

| Message                             | eve reads it as                       | Result                                                                                                         |
| ----------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Alice: "approve" (or "1")           | Approve for `a1`                      | eve runs the call, as in row 4                                                                                 |
| Alice: "cancel" (or "2")            | Cancel for `a1`                       | The call's result says declined; the model is called with it                                                   |
| Alice: "actually, send it to Carol" | Steering                              | `a1` is withdrawn (`ignored`); the model reads the not-run result, then her message                            |
| Bob: "approve"                      | Waits. Bob isn't the turn's requester | Bob's message runs after `turn_1` ends. Bob can still answer `a1` with a button, if the response policy allows |

## Sign-ins

Two things can stop a call before it finishes, and eve learns about them at different times: an
approval before the call runs, and a sign-in only while it runs (the tool asks for a token with
`getToken` or `requireAuth` and there is no credential yet).

`requireSignIn` stops the calls that need the sign-in and emits `authorization.required`; the turn
holds until every sign-in calls back. An approved call that needs a sign-in leaves its suspended
step, and the model calls it again once the sign-in completes. Sign-ins stay in
`pendingAuthorization` in #4217; moving them is a later step.

Workflow bodies keep their own sign-ins: the run waits on its own hook, and the session only
publishes the events (`execution/tools/workflow/step.ts`).

## Budget questions

A budget question has no tool call. Before every model call, eve checks the session's budget. Over
budget, `requestLimit` emits `input.requested`. With nobody to answer, the turn fails with
`SESSION_TOKEN_LIMIT_REACHED`, and a child that inherited a zero budget fails so its parent asks
instead, as today.

In #4217, the budget question holds the turn like an approval (`turn.waiting`, `on: "input"`).
Continue grants a fresh budget and makes the model call the turn was about to make, in the same
turn. Stop cancels the turn, and the question resolves once, `answered`. In #4142, `requestLimit`
ends the turn instead (see Where #4217 and #4142 differ).

A message from the requester while the question is open is queued and runs after Continue. A steer
does not withdraw the budget question. Cancel withdraws it (`input.resolved` `cancelled`).

## Steer and cancel

| Input                    | Approvals                                                   | Sign-ins                     | Budget question | Relayed questions                                      |
| ------------------------ | ----------------------------------------------------------- | ---------------------------- | --------------- | ------------------------------------------------------ |
| Steer from the requester | Unanswered ones `ignored`; answered ones keep their answers | Declined (`withdrawSignIns`) | Stays open      | Answered when it takes free text (#4035), as on `main` |
| Message from anyone else | Unchanged; the message waits for the turn to end            | Unchanged                    | Unchanged       | Unchanged                                              |
| Cancel                   | Withdrawn                                                   | Withdrawn                    | Withdrawn       | Withdrawn, and the owning run or child is cancelled    |

Cancel emits one `input.resolved` per request, at the coordinates of the step that asked.

## History is append-only

Alice's agent has a `turn.started` instruction with role `user` that writes the current time, the
setup from #3899. Alice asks it to email the report to Bob at 10:00 and clicks Approve at 10:02.

### Status quo: the waiting call is held out, then spliced back in

```text
user       "email the report to Bob"
user       [Pending approvals] send_email
assistant  tool-call send_email (c1)                        written back after the answer
tool       tool-approval-response (approved)                must be last
```

Until #3903, the memory-recall path appended the 10:02 timestamp after the approval response. That
is #3899: the SDK found no approval at the tail, never ran `send_email`, and the provider rejected
the request ("No tool output found for function call c1"). Every writer has to know the same rule:

- Current-turn context is sent as a system message instead of being written to history
  (`harness/current-messages.ts`).
- A message that arrives with the approval answer is held until the next step
  (`harness/input-requests.ts`).
- A denial also writes an `execution-denied` result, because the SDK strips old approval responses
  when it builds the provider prompt (`harness/hitl/approval-input-requests.ts`).

### Proposed: a step joins history only when complete

```text
user       "email the report to Bob"                        10:00
                                                            10:00-10:02: c1 is in TurnState, not history
assistant  tool-call send_email (c1)                        10:02, committed with its result
tool       tool-result c1: sent                             eve ran it after Approve
assistant  "Sent the report to Bob."
```

If Alice steers at 10:01 instead:

```text
user       "email the report to Bob"                        10:00
assistant  tool-call send_email (c1)                        10:01, committed when a1 is withdrawn
tool       tool-result c1: not run; Alice sent a new message
user       "actually, send it to Carol"                     10:01, steering
```

No approval part is ever in history, so a write after the call can't strand it. The answer
continues `turn_1`, so `turn.started` doesn't fire again.

## Stream events

| Event                                       | `main` today                                                | Proposed                                |
| ------------------------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| After `input.requested` (approval, sign-in) | `turn.waiting` `on: "input"` (#4135)                        | Unchanged                               |
| After `input.requested` (budget question)   | `turn.completed`, `session.waiting`                         | `turn.waiting` `on: "input"` (#4217)    |
| An approved call's result                   | `action.result` from the SDK's run in the next `generate()` | `action.result` from `runApprovedCalls` |
| A steer withdraws an approval               | `input.resolved` `ignored`                                  | Unchanged                               |
| Cancel                                      | One `input.resolved` for all approvals                      | One `input.resolved` per request        |

Three rules keep events uniform across the turn's own and relayed requests:

- **One publisher.** A request's events are published once, by the session that holds it, on the
  same path as every other event, so hooks and channels see them. For a relayed child request that
  is the root, whose channel showed the prompt (#2520, #3784, #3990).
- **Every park says so.** Each time a held turn parks, including after a rejected answer, it emits
  `turn.waiting` (#3757).
- **One source of approval state.** Clients read an approval's state only from `input.requested`
  and `input.resolved`, not from parts in history (#3911).

## Invariants

1. Only `apply` publishes HITL events and writes `TurnState`. Transitions are pure.
2. A step's response joins history only when every call it made has a result there. AI SDK approval
   parts never enter history.
3. The model is never called while an approval is open (#4217).
4. Every event of one request carries the requesting turn's `turnId`.
5. A gated call runs only in its own held turn, after its requests are answered, with the asking
   step's tools.
6. The approval policy runs once per call, and again as `recheckApprovedCall` before an approved
   call runs. The response policy runs once per answer.
7. Only a person's answer grants. Model output never answers a request.

## What this removes

- The AI SDK `toolApproval` run path for approved calls, `hasTailApprovalResponse`, and the
  preamble reordering for approvals (`harness/current-messages.ts`).
- The call held outside history and spliced back, and the `[Pending approvals]` note
  (`harness/hitl/approval-prompt.ts`) (#4217; see Where #4217 and #4142 differ).
- The pending input batches and deferred step input (`harness/pending-input-batches.ts`), the
  coordination batch, and `eve.runtime.hitl.approvedTools`, replaced by `TurnState`.
- The harness's separate answer paths for approvals and budget questions (`resolveTextMessageInput`,
  `routePendingInput` in `harness/input-requests.ts`), replaced by intake and `answer`.

Kept: `approvalState` for response-policy candidates, `pendingAuthorization` until sign-ins move,
`openInputRequests` on `main` until the projection lands, and workflow-body sign-ins.

## Where #4217 and #4142 differ

#4217 ports the parts of #4142 that don't need #4141 or #4178. It takes most rules from #4142 and
keeps two of its own, to be reconciled in Owen's stack.

| Decision                                           | #4217                                                                 | #4142                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Budget question                                    | Holds the turn, like an approval                                      | `requestLimit` ends the turn                                     |
| Suspended steps with open approvals                | At most one; the model is not called while one is open; no note       | Several; the model is called with the `[Pending approvals]` note |
| Response-policy candidates                         | Durable records in `approvalState` (candidates, history, settlements) | Same                                                             |
| Typed replies                                      | Answer whatever matches (see Typed replies)                           | Same                                                             |
| Leftover responses                                 | Queued                                                                | Same                                                             |
| `once()` grant while an approval for its key waits | Hidden                                                                | Same                                                             |

## Migration

Pre-1.0: breaking, no dual path. Sessions parked under the old model are not rewritten. The handoff
check refuses to move a session that still holds an old batch, approval, or relay key, so it
finishes on the deployment that can still answer it.

1. #4217 on `main`: `TurnState`, the HITL transitions, eve-run approved calls, and the budget
   question holding the turn. Open-ness stays in `openInputRequests`.
2. Plain-tool sign-ins move out of `pendingAuthorization`.
3. #4141 and #4178 land; the projection replaces `openInputRequests`, and #4142 reconciles the two
   differing decisions.
4. Clients and channels read approval state only from `input.*` events.

## Alternatives considered

Running each gated call as a task (a separate workflow run that asked the person and ran the call)
kept the conversation going while an approval waited, but the run had to rebuild dynamic tools,
the session's sandbox, and agent-tool dispatch outside the session. Keeping the AI SDK as the runner
of approved calls in held turns kept its re-check and streaming for free, but left the
last-message rule in place, so every writer still had to protect the tail. Running approved calls
in eve with the asking step's tools needs neither and removes the rule.

## Open questions

1. **Sign-in calls: does eve re-run them, or are they removed from history?**
   - Known: on `main` the interrupted call is removed (`projectCompletedSiblingCalls`). In #4142,
     `requireSignIn` stops the calls, and the model calls them again after the sign-in.
   - Not known: whether eve should re-run the call itself after the sign-in, as it does approved
     calls, so the model doesn't have to repeat it.
2. **How do the two #4217-owned decisions reconcile with #4142?**
   - The budget question holding the turn versus `requestLimit` ending it.
   - One suspended step with open approvals and no model call versus several with the
     `[Pending approvals]` note.
3. **When does the projection replace `openInputRequests`?**
   - Known: it needs #4141 (stream v27 facts and the session projection) and #4178 (step pipeline).
   - Not known: whether relayed requests move in the same change or after it.

## Validation

#4217 keeps `main`'s e2e set passing and adds tests for each step. It passes if:

1. The reproductions for #3899, #2826, and #3594 pass, and no approval part reaches history.
2. Every event of one approval carries one `turnId`, and the call runs under the requesting turn's
   principal and connections (the #3705 and #3760 shapes).
3. #3891's step, an approval next to a blocking workflow tool, runs the response policy for Approve
   and Cancel with no park-site flag.
4. An approval-gated dynamic tool, a sandbox tool, and an agent tool each run after Approve, in the
   same turn, and a re-check that denies stops the call.
5. A steer while an approval is open withdraws it as `ignored`, declines open sign-ins, and leaves
   the budget question open.
6. A budget question holds the turn: Continue runs the pending model call under the same `turnId`,
   Stop cancels the turn and resolves the question once, and cancel withdraws it.
7. A typed reply that matches some of a step's approvals answers those, and the rest keep waiting.
8. Cancel emits one `input.resolved` per open request.
