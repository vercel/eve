---
issue: https://github.com/vercel/eve/issues/1224
status: draft
last_updated: "2026-08-27"
---

# HITL requests: one parking mechanism, independent variants

## Summary

eve's HITL surfaces — tool approval, `ask_question`, session limits, and
connection authorization — share one essential mechanism: the session owes an
answer, parks something, and resumes when data arrives. Today that mechanism
is re-implemented per variant and fused to each variant's rules, which is the
structural cause of the wedge-class bugs catalogued in the HITL request
lifecycle research
([#1224](https://github.com/vercel/eve/issues/1224), referenced below as
"#1224" with its transition-catalog anchors).

This proposal factors the machine along two orthogonal axes:

- **Variant** — _what is owed_: adjudication rules, outcome vocabulary,
  supersession. Four exist: Approval, Question, Limit, Challenge.
- **Owner** — _who waits_: the parked session turn, a framework gate, or a
  durable tool-body run. An owner is a hook token — nothing more.

A shared **interpreter** owns everything variant- and owner-agnostic: rows, candidate
races, groups, continuations, tombstones, staleness, forced closure,
projection routes, and park/resume addressing. Variants become small pure
reducers. Owners become hook consumers. The #1224 transition catalog was
audited row-by-row against this model: `owner.batch.*`, `scheduler.*`,
`projector.*`, and all cancellation rows land in the interpreter and are proven
once; `owner.approval.*`, `owner.question.*`, `owner.limit.*`, `owner.auth.*`
each land in exactly one variant file and are proven in isolation. The audit
surfaced exactly three modulations, absorbed without new exported concepts:
held-candidate cancellation (`candidate-cancelled`), per-variant stale
visibility (`staleResponses`), and interpreter-scheduled deadlines. Invariant 10 ("composite states add
no cases") becomes structural: variants cannot reference each other, so
composite behavior is the row-wise union by construction.

The first new owner class is the **tool-body run**: background tools whose
`execute` is a workflow function may open requests mid-body and `await`
them, giving framework users mid-task HITL (`ctx.request`, `ctx.auth`)
through the same interpreter that implements eve's internal permissioning.

## Model

Three exported concepts. Everything else is interpreter-internal or an existing
eve concept reused. A compiling prototype lives beside this doc in
[`hitl-requests/`](./hitl-requests/): `interpret.ts` (the
interpreter), `variants.ts` (all four reducers against real harness shapes),
`ledger.ts` (derivation from the existing batch state), and `seam.ts` (the
`tool-loop.ts` call site, unchanged).

**A row is one element of today's `PendingInputBatch.requests`** — one open
request, flattened out of the batch it arrived in. A batch is not a state
shape of its own: it is the set of rows sharing a `groupId`, and the batch's
withheld `responseMessages` become that group's continuation payload. The
existing batch semantics are preserved by construction, not reimplemented:
independent answerability across batches (`appendPendingInputBatch`) is rows
in different groups never interacting; request-id uniqueness
(`assertUniqueRequestIds`) is uniqueness in the flat table; removal-only
shrinkage (`removePendingInputBatches`) is rows transitioning open → terminal
with nothing overwriting rows it never resolved; withheld output appearing
zero times until closure is the continuation payload spliced exactly at
claim. During migration the batch collection remains the persisted
representation — the interpreter derives its ledger from it
(`ledgerFromSessionState`); only interpretation moves.

```ts
/** One open item, durably stored. Interpreter-owned shape. */
interface Row<Spec> {
  id: RequestId;
  kind: VariantKind;
  spec: Spec; // variant-owned data, opaque to the interpreter
  owner: string; // hook token — where closure payloads deliver
  groupId: GroupId;
}

/**
 * What the interpreter feeds a variant. `message` carries no text:
 * text-matching against open requests is unrepresentable by construction.
 */
type Input =
  | {
      kind: "response";
      response: InputResponse;
      responder: Responder | null;
      actor: "originating" | "other" | "anonymous";
    }
  | { kind: "message"; actor: "originating" | "other" | "anonymous" }
  | { kind: "callback"; params: JsonObject }
  | { kind: "deadline" }
  | { kind: "linked"; outcome: string }; // a row this one blocked on completed

/** Complete verdict vocabulary — nothing else exists. */
type Verdict<Outcome> =
  | "ignore"
  | { settle: Outcome }
  | { reject: "unauthorized" | "invalid" | "policy-failed" | "candidate-cancelled" }
  | { dismiss: string; reopen?: unknown; consumeDelivery?: true }
  | { blockOn: ChallengeSpec }; // open a linked row; re-feed me via "linked"

interface Variant<Spec, Outcome> {
  resolve(row: Row<Spec>, input: Input): Verdict<Outcome> | Promise<Verdict<Outcome>>;
  intentKey?(spec: Spec): string | undefined; // interpreter dedup (invariant 4)
  present(row: Row<Spec>): Presentation; // InputRequest | AuthorizationChallenge
  /**
   * How a stale response against this variant's tombstones surfaces.
   * Default "context-turn": synthetic context message + context turn so the
   * agent can answer in-channel. "drop": rejected event only, no model call
   * — required by Limit (`owner.limit.response.reject-stale`), whose stale
   * answers must never reach the model.
   */
  staleResponses?: "context-turn" | "drop";
}
```

Notes on the boundary:

- **Staleness detection is interpreter-side.** A response naming a terminal row
  is rejected against the tombstone before any reducer runs; `"stale"` is
  deliberately absent from the reject vocabulary and no variant implements a
  second staleness mechanism. Stale *visibility* is the one per-variant
  modulation (`staleResponses`), because Limit requires silent drops where
  approval and question require a context turn.
- **Races are interpreter-side.** Candidates derive from `{requestId,
deliveryId}`; single-winner serialization happens before `resolve`.
- **`present()` selects the event family.** Returning an `InputRequest`
  implies `input.*` lifecycle events; returning a challenge implies
  `authorization.*`. The two wire vocabularies are preserved — challenges
  remain outside the input-request wire vocabulary, per #1224.
- **`resolve` may be async** (authored approval policies run inside it,
  step-wrapped). This deviates from #1224's strictly pure `interpretHitl`;
  policy evaluation is deterministic-by-journaling rather than pure. A
  policy throw or timeout becomes `{ reject: "policy-failed" }` and the row
  stays open (interpreter rule).

## Interpreter contract

Owned unconditionally, with no per-kind branches:

| Primitive              | Guarantee                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rows                   | open → terminal exactly once; tombstones retained until session end                                                                                                    |
| Candidates             | atomic single-winner; later candidates rejected stale                                                                                                                  |
| Groups + continuations | closure iff all members terminal; `pending → claimed \| suppressed` exactly once                                                                                       |
| Forced closure         | turn-cancel / session-end dismisses rows and suppresses continuations uniformly                                                                                        |
| Intent dedup           | a raise whose `intentKey` matches an open row resolves already-pending (fail-open when unkeyed)                                                                        |
| Projection routes      | the #1224 Route machine verbatim; routes reference rows by id, never by kind                                                                                           |
| Park/resume addressing | durable hook + capability-alias demux; registration committed before any resume URL is advertised; disposed owners reject resumes (route-lost, never a parent failure) |
| Events                 | state persisted before effects; every admitted input yields an observable event                                                                                        |

Two verdict fields are the licensed irregularities, both interpreter-enforced:
`consumeDelivery` (at most one consumer per delivery; the consumed message
still emits observable events — Limit is its only user) and `reopen`
(dismiss-and-replace with interpreter-owned monotonic identity).

`blockOn`/`linked` is the one cross-variant linkage: a reducer may park a
candidate on another row reaching terminal state. The blocking variant names
a row it wants terminal, never the other variant's rules; the blocked-on
variant never knows it was watched. Held candidates are interpreter state with two
rules: a duplicate delivery of the same candidate returns the existing held
candidate and never opens a second linked row, and a row settling while a
candidate is held (for example an authenticated cancel racing a pending
sign-in, `owner.approval.response.settle-cancel-pending-candidate`) completes
the linked row as `cancelled` and rejects the held candidate as
`candidate-cancelled` — the variant is not consulted.

Timers are interpreter-scheduled: a spec carrying a deadline gets a `deadline`
input as a first-class interpreter producer (the producer #1224 stage 3 notes is
missing today), never a variant-owned wait.

## The four variants

Reference implementations; each is the complete rule set for its #1224
catalog family.

```ts
export const question = defineVariant<QuestionSpec, QuestionOutcome>({
  present: (row) => inputRequest("question", row.spec),
  resolve(row, input) {
    switch (input.kind) {
      case "response": {
        const { optionId, text } = input.response;
        if (optionId !== undefined && !row.spec.options?.some((o) => o.id === optionId))
          return { reject: "invalid" };
        return { settle: { status: "answered", optionId, text } };
      }
      case "message":
        return input.actor === "originating" && row.spec.supersedable
          ? { dismiss: "superseded" }
          : "ignore";
      default:
        return "ignore";
    }
  },
});
```

```ts
export const approval = defineVariant<ApprovalSpec, ApprovalOutcome>({
  intentKey: (spec) => spec.approvalKey,
  present: (row) =>
    inputRequest("tool-approval", { action: row.spec.action, display: "confirmation" }),
  async resolve(row, input) {
    if (input.kind === "linked")
      return input.outcome === "authorized"
        ? adjudicate(row, input.heldResponse)
        : { reject: input.outcome === "declined" ? "unauthorized" : "policy-failed" };
    if (input.kind !== "response") return "ignore"; // text never settles an approval
    if (!["allow", "deny", "cancel"].includes(input.response.optionId ?? ""))
      return { reject: "invalid" }; // owner.approval.response.reject-invalid
    if (input.response.optionId === "cancel")
      return input.responder !== null ? { settle: "cancelled" } : { reject: "unauthorized" };
    return adjudicate(row, input);
  },
});

async function adjudicate(row, input): Promise<Verdict<ApprovalOutcome>> {
  const decision = await row.spec.responsePolicy({
    responder: input.responder,
    request: row.spec.action,
  });
  if (decision.status === "rejected") return { reject: "unauthorized" };
  if (decision.status === "needs-auth") return { blockOn: decision.challenge };
  return { settle: input.response.optionId === "allow" ? "allowed" : "denied" };
}
```

Per-tool dynamic approval semantics stay where they live today. The reducer
owns no policy: `row.spec.responsePolicy` is the tool's resolved authored
`Approval`, injected per-row at interpretation time from the live
`HarnessToolMap` — the same late binding `resolveApprovalKeyFromTools` and
`coordinateApprovalDelivery` perform now, generalized from the approval key
to the whole policy surface (prototype `seam.ts`, `bindApprovalPolicy`). A
tool changing its approval semantics between park and response is
adjudicated by the current policy, exactly as today; the interpreter never
touches the tool registry.

```ts
export const limit = defineVariant<LimitSpec, LimitOutcome>({
  present: (row) => inputRequest("session-limit", promptFor(row.spec)),
  staleResponses: "drop", // stale limit answers must never reach the model
  resolve(row, input) {
    switch (input.kind) {
      case "response":
        return { settle: input.response.optionId === "continue" ? "continued" : "stopped" };
      case "message":
        return {
          dismiss: "superseded",
          reopen: { ...row.spec, generation: row.spec.generation + 1 },
          consumeDelivery: true,
        };
      default:
        return "ignore";
    }
  },
});
```

```ts
export const challenge = defineVariant<ChallengeSpec, ChallengeOutcome>({
  present: (row) => authorizationChallenge(row.spec),
  resolve(row, input) {
    switch (input.kind) {
      case "callback":
        return { settle: readCallbackOutcome(input.params) };
      case "deadline":
        return { settle: "timed-out" };
      default:
        return "ignore";
    }
  },
});
```

Stale generations never reach the Limit reducer: the generation is part of
the request id, so a `gen-1` response hits a tombstone. Forced closure of a
Challenge maps to `completed(cancelled)` in the interpreter's dismissal-to-
vocabulary translation — the one place kind leaks into interpreter output.

## Where the interpreter runs: the existing seam

HITL interpretation runs today between harness steps — the model step ends,
the harness parks (`appendPendingInputBatch`, `tool-loop.ts:2806`), and the
next step begins by resolving pending input (`resolvePendingInput`,
`tool-loop.ts:1050`, preceded by `coordinateApprovalDelivery`). The interpreter
does not move that seam; it replaces what runs inside it:

```text
today:   coordinateApprovalDelivery → routePendingInput → one of three
         domain resolvers (approval / question / session-limit)
         → ResolvePendingInputResult

target:  ledgerFromSessionState → interpretDelivery → translateEffects
         → ResolvePendingInputResult          (same call site, same contract)
```

Convergence means one interpreter inside the existing seam instead of
coordinator + router + three domain resolvers — not a new execution point.
Mid-step approval gating still surfaces at step end via AI SDK approval
parts; the park side (`appendPendingInputBatch`) is consumed by `raiseRows`
at the next pass. The body-run owner introduces no second seam either: it is
reachable only in background tasks where the step already ended with a
receipt, and its deliveries arrive through its own inbox, interpreted by the
same interpreter pass. The prototype's `seam.ts` states the exact call-site
contract, including how each `LedgerEffect` translates into today's
`ResolvePendingInputResult` fields (`rejectedActions`, `resolvedInputs`,
`deferredMessage`, `limitContinuation`).

## Owners

An owner is a hook token. The interpreter delivers settlement and dismissal
payloads to `row.owner` over the existing durable session-inbox envelope
(`resumeSessionInbox`); what the consumer does with them is its own business.

- **Session turn** — today's behavior, unchanged: resume restores withheld
  output, appends member outcomes, runs allowed tools once, resumes the
  model. The ApprovalBatch continuation is a interpreter group whose owner is the
  session inbox.
- **Framework gate** — the step-end approval park; same rows, no bespoke
  AI SDK approval-part state.
- **Tool-body run** _(new)_ — a framework-owned workflow run hosting a
  background tool's `"use workflow"` `execute`. Its inbox is a new executor
  kind on the existing task child wire; the task run workflow stays the
  single lifecycle writer, unchanged. The parent session projects body-owned
  rows through the interpreter's Route machine, exactly as for child sessions.

The #1224 rule "no blocked continuation anywhere" (invariant 1) becomes an
owner-contract clause: every owner's waiting frame must be force-resumable
from row state alone. The body run's `await` is legal because forced closure
rejects the promise (running `finally` blocks); the historical wedges were
waits that only one specific input could release.

## Authoring surface: mid-task HITL

Available only in task-backed workflow tools, where a receipt has already
settled the model-facing call and the session stays receptive:

```ts
export default defineTool({
  description: "Deploy a service to production.",
  inputSchema: z.object({ service: z.string(), ref: z.string() }),
  async execute(input, ctx: WorkflowToolContext) {
    "use workflow";
    const plan = await buildPlan(input);

    const approval = ctx.request({
      // opens an Approval row, owner = this run
      id: "approve-plan",
      kind: "approval",
      prompt: `Apply ${plan.changes.length} changes to ${input.service}?`,
      options: [
        { id: "apply", label: "Apply", style: "danger" },
        { id: "abort", label: "Abort" },
      ],
    });

    const decision = await Promise.race([
      approval,
      ctx.sleep("4h").then(() => ({ optionId: "abort", timedOut: true })),
    ]);
    if (decision.optionId === "abort") return { status: "aborted" };

    const token = await ctx.auth("acme"); // opens a Challenge row, same interpreter
    return await applyPlan(plan, token);
  },
});
```

Semantics:

- `ctx.request` opens a Question or Approval row and returns a promise
  resolved by the interpreter's demux over the body run's single inbox. No new
  variants, no new verdicts: the parking mechanism is `row.owner`.
- Every result carries a status (`answered | ignored | allowed | denied |
cancelled`); dismissal and cancellation resolve or reject the promise so
  authored `finally` blocks run.
- Request ids are authored (unique per run, deterministic error on
  collision) or journal-order derived for replay determinism.
- `.url` on the returned handle is a capability alias
  (`POST eve/v1/task-input/:token`); it resumes anonymously
  (`responder: null`) and the variant's response policy decides whether
  that is acceptable. Identity-bearing paths (channel delivery, parent
  projection) forward the verified responder unchanged; the body run owns
  adjudication.
- `ctx.auth` opens a Challenge row and resolves to the token result; it
  replaces the signal-return park (`requestAuthorization` /
  `getAuthorizationResult`) for workflow tools. Plain tools keep the
  re-entrant signal mechanics; their representation unifies as Challenge
  rows, their authoring surface does not change.
- While rows are open and the run is suspended, the task projects
  `input_required` with the open requests; the parent wake/proxy wire is
  today's.

## Migration

Each legacy HITL store has exactly one destination:

| Legacy                                            | Destination                                                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `eve.runtime.pendingInputBatches`                 | One interpreter group per batch; each request becomes an Approval/Question row; withheld `responseMessages` become the group's continuation payload |
| `eve.runtime.deferredStepInput`                   | Deleted as a mechanism (per #1224); wedged messages release as ordinary message turns on the first delivery after upgrade                      |
| `eve.runtime.pendingAuthorization`                | Challenge rows in one group; the journaled `resume` payload becomes continuation payload                                                       |
| `eve.runtime.hitl.approvalState`                  | Interpreter candidate records and tombstones                                                                                                        |
| `eve.runtime.hitl.approvedTools`                  | Unchanged — policy input (`ApprovalContext.approvedTools`), not request state                                                               |
| Task synthetic `task:authorization:*` blocker ids | Deleted; a child's challenge is a real Challenge row owned by the child, projected to the parent as an interpreter route                             |

Mechanics:

- One-shot migration on first load per session through
  `execution/durable-session-migrations/`: read legacy keys, build the
  ledger, first write persists only the new shape. No dual-write period, no
  legacy fallback logic.
- Task views need no rewrite: the `eve.task` stream is append-only; new code
  appends new-shape `input_required` views, old snapshots stay historically
  readable, and the task run translates on its next transition.
- The wire is untouched: `InputRequest`/`InputResponse` shapes, request ids,
  and capability URLs survive migration byte-identically. One scoped break,
  shared with #1224: challenge URLs minted pre-cutover embed the old
  `${sessionId}:auth` hook token — ship a one-release token alias or accept
  the in-flight break under pre-1.0 policy.

## Relationship to #1224 and sequencing

This is a refinement of the #1224 target architecture, not a competitor:
stages 1–2 (store foundation, interpreter extraction) build the interpreter;
this doc adds the internal seam `interpret.ts` + `variants/*.ts` and the owner
axis. Stage 3 (auth through the machine) becomes the Challenge variant.
The transition catalog and its eval anchors remain the conformance suite,
re-anchored by axis: interpreter rows proven once, variant rows proven per
variant, composite coverage generated as unions.

Order of work:

1. **Interpreter + variants** — #1224 stages 1–3 with the variant seam.
2. **Body-run owner** — new executor kind on the task child wire; demux;
   `ctx.request` / `ctx.auth`; responder forwarding added to the task
   input wire (additive). Depends on workflow functions as
   `defineTool.execute` (the subagents-as-workflow-tools research, §6.1).
3. **Gate unification** — the framework approval gate re-expressed as
   interpreter rows (representation change; step-end park mechanics retained).

## Open questions

1. **Async `resolve` vs. pure interpreter.** Policy evaluation inside the
   reducer trades #1224's strict purity for one seam; the alternative
   (policy as a pre-resolved input) doubles the input alphabet. Decide at
   stage-2 extraction.
2. **Deployment pinning for parked bodies.** Multi-hour parks across
   redeploys are the common case for body-run owners; the pinning policy
   (subagents doc §7.3) must be stated publicly before the authoring
   surface ships.
3. **Journal growth.** Row specs (prompts, options) persist in the ledger
   and task view snapshots; a size cap and truncation rule are needed.
4. **Foreground workflow tools.** `ctx.request` is task-backed only; the
   foreground example in the subagents doc (§4) should be amended or
   scoped to receipts.
