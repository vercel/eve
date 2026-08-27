---
issue: https://github.com/vercel/eve/issues/1224
status: draft
last_updated: "2026-08-27"
---

# HITL requests: one parking mechanism, independent variants

## Motivation

eve's HITL surfaces — tool approval, `ask_question`, session limits,
connection authorization — share one essential mechanism: the session owes an
answer, parks something, and resumes when data arrives. Today that mechanism
is re-implemented per surface and fused to each surface's rules. The HITL
request lifecycle research
([#1224](https://github.com/vercel/eve/issues/1224)) measured the cost:
interpretation smeared across ~6,800 lines in 14 principal modules, with no
single place that sees the whole state — which is exactly how both
wedge-class bugs shipped (#1224, #1830, #1868: an obligation encoded as a
blocked continuation instead of as data).

| Fragment | Today lives in |
| --- | --- |
| batch resolution, defer decisions | `harness/input-requests.ts` |
| batch + deferred-input storage | `harness/pending-input-batches.ts` |
| stale-response conversion (a second interpreter) | `harness/stale-input-responses.ts` |
| required/dismissable classification | `harness/input-request-class.ts` |
| approval candidates + response policies | `harness/approval-delivery-coordinator.ts`, `harness/approval-candidates.ts` |
| limit prompt creation + resolution special cases | `harness/session-limit-*.ts` |
| challenge storage + callback pairing | `harness/authorization.ts`, `execution/workflow-steps.ts` |
| projection routing | `harness/proxy-input-requests.ts`, `execution/subagent-hitl-proxy.ts` |

#1224 proposes the fix: one obligation state machine, one pure interpreter,
everything else an adapter. This doc refines that target with one more split —
**the interpreter splits into a variant-agnostic core and four independent
reducers** — and adds an owner axis that turns the same machine into a
user-facing capability: tools that park on human input mid-task.

## The factoring

Two independent axes, entangled today:

- **Variant** — _what is owed_: response-handling rules, outcome names,
  supersession. Approval, Question, Limit, Challenge.
- **Owner** — _who waits_: the parked session turn, the framework approval
  gate, or a durable tool-body run. An owner is a hook token — nothing more.

```text
                  ┌──────────────────────────────┐
 variants ───────▶│         INTERPRETER          │◀─────── owners
 (what is owed)   │ rows · candidates · groups · │  (who waits)
                  │ continuations · tombstones · │
 approval         │ staleness · forced closure · │  session turn
 question         │ intent dedup · routes ·      │  framework gate
 limit            │ park/resume addressing       │  tool-body run (new)
 challenge        └──────────────────────────────┘
```

The interpreter owns everything on the middle box, with no per-kind
branches. Each variant is one reducer — `resolve(row, input) → verdict` — a
screen of code, pure over its inputs, unaware of parks, sessions, batches,
or the other variants. Each owner is a consumer of settlement payloads on a
hook token. #1224's invariant 10 ("composite states add no cases") becomes
structural: variants cannot reference each other, so composite behavior is
the row-wise union by construction.

A compiling prototype lives in [`hitl-requests/`](./hitl-requests/):

- `interpret.ts` — the pass: staleness → candidate identity → reducer
  dispatch → verdict application → group closure; `closeForced`; `raiseRows`
  (intent dedup)
- `variants/{approval,question,limit,challenge}.ts` — the complete rule set
  for each #1224 catalog family, one file each
- `ledger.ts` — derivation from the existing batch state (the migration
  import)
- `store.ts` — consistent storage: `read` / CAS `write`, blobs held apart
- `call-site.ts` — the `tool-loop.ts` integration point, unchanged
- `types.ts` — the three exported concepts below

## Model

```ts
/** One open request — one element of today's PendingInputBatch.requests. */
interface Row<Spec> {
  id: RequestId;
  kind: "approval" | "question" | "limit" | "challenge";
  spec: Spec; // variant-owned, opaque to the interpreter; durable facts only
  owner: string; // hook token — where settlement payloads deliver
  groupId: GroupId; // rows raised by one park; closure fires once per group
}

/** What the interpreter feeds a reducer. `message` carries no text. */
type Input =
  | { kind: "response"; response: InputResponse; responder: Responder | null;
      actor: "originating" | "other" | "anonymous" }
  | { kind: "message"; actor: "originating" | "other" | "anonymous" }
  | { kind: "callback"; params: JsonObject }
  | { kind: "deadline" }
  | { kind: "linked"; outcome: string }; // a row this one blocked on completed

/** Every verdict a reducer can return — the closed set. */
type Verdict<Outcome> =
  | "ignore"
  | { settle: Outcome }
  | { reject: "unauthorized" | "invalid" | "policy-failed" | "candidate-cancelled" }
  | { dismiss: string; reopen?: unknown; consumeDelivery?: true }
  | { blockOn: ChallengeSpec }; // open a linked row; re-feed me via "linked"
```

A batch is not a state shape: it is the set of rows sharing a `groupId`, and
its withheld `responseMessages` are that group's continuation payload,
spliced exactly once at closure. Today's batch invariants map one-to-one —
independent answerability is disjoint groups, `assertUniqueRequestIds` is
flat-table uniqueness, removal-only shrinkage is open → terminal.
`ledgerFromSessionState` derives the ledger from the legacy batch keys; it
is the one-shot migration import (see Storage and Migration).

Boundary rules — each one deletes a module from the table above:

- **Staleness is interpreter-side** — a response naming a terminal row
  rejects against the tombstone before any reducer runs (`stale` for
  tombstones, `invalid` for unknown ids). Deletes
  `stale-input-responses.ts`. The one per-variant setting is visibility:
  Limit drops stale answers silently; others produce a context turn.
- **Races are interpreter-side** — candidate identity is
  `{requestId, deliveryId}`; single-winner before `resolve`; redeliveries
  reuse held candidates. Absorbs `approval-candidates.ts`.
- **Classification is the variant kind.** Deletes
  `input-request-class.ts` — "text never settles an approval" is the
  approval reducer returning `"ignore"` for non-responses, one line.
- **The reducer never sees text.** Message inputs carry only the actor
  relation, so text-matching against open requests is unrepresentable.
- **`blockOn`/`linked` is the one cross-variant edge** — a reducer parks a
  candidate on another row reaching terminal (approval's
  needs-auth), naming a row it wants terminal, never the other variant's
  rules. Held candidates settle-cancel and dedupe interpreter-side.
- **`resolve` may be async** — authored approval policies run inside it,
  step-wrapped; throw/timeout becomes `policy-failed` with the row open.
  This deviates from #1224's strictly pure `interpretHitl` (open question 1).

## Dynamic approval policies

Approval policies are authored code, and dynamic tools exist only in the
steps that advertised them — a policy function cannot be persisted with a
row. Specs store durable facts only (the gated `action`, the computed
`approvalKey` string, and `responseAuthRequired`: "this tool had a response
policy when it asked" — today's `responseAuthRequiredRequestIds`). The
policy is late-bound every pass from the live `HarnessToolMap`
(`call-site.ts:bindApprovalPolicy` — the `authorizeCandidate` lookup at
`approval-delivery-coordinator.ts:334`, generalized). When the lookup finds
nothing (ephemeral tool, redeploy), the park-time flag decides: no policy
ever required → settle directly; policy required but unavailable → fail
closed with `policy-failed`, row stays open and answerable after a redeploy.

## The call site does not move

HITL interpretation runs today between harness steps; the interpreter
replaces what runs behind that call site, not where it sits:

```text
today:   coordinateApprovalDelivery → routePendingInput → one of three
         domain resolvers (approval / question / session-limit)
         → ResolvePendingInputResult

target:  ledgerFromSessionState → interpretDelivery → translateEffects
         → ResolvePendingInputResult        (same call site, same contract)
```

Same call site (`tool-loop.ts:1050`), same park side
(`appendPendingInputBatch` → consumed by `raiseRows`), same result contract.
Mid-step approval gating still surfaces at step end via AI SDK approval
parts.

## Storage

Today HITL state rides in workflow step results — the whole
`SessionStateMap` (pending batches, `pendingAuthorization`, approval audit
state, the withheld `responseMessages`) re-serializes into every
`DurableSessionSnapshot`. Free atomicity, but: no read path without
hydrating a run, full-snapshot rewrite per step, unbounded journal growth
from the withheld blobs.

The ledger moves to a dedicated store (prototype
[`store.ts`](./hitl-requests/store.ts)) — the same shape as
`MemoryDocumentBackend`: `read` / conditional `write` / conflict error.
Derived reads (`openRows`) are pure functions over the ledger, not store
methods, so backends cannot diverge on query semantics. Default backend via
nitro (`db0` locally, the deployment's database in production); the
interface stays eve-owned.

```ts
interface RequestLedgerStore {
  read(scope: LedgerScope): Promise<VersionedLedger | null>;
  write(scope, ledger, expectedVersion: string | null): Promise<VersionedLedger>; // CAS
}
```

Rules that keep the store from becoming a coordination point:

- **The store is the persistence and read plane; the inbox stays the
  serialization plane.** Only the interpreter pass writes, still fed
  through the owner's inbox — one writer per scope, arrival order unchanged
  (#1224 invariant 5). Routes and channels read; they never write.
- **Scope is the root session id.** Body-run rows live under their root
  session's scope — the parent projection reads them — never under the
  run's own id.
- **Blobs live beside the ledger, not in it.** A group's continuation
  payload (the withheld model output) is a separate record written once at
  park, read once at claim; `read` returns rows, groups, and held
  candidates only. This closes most of the journal-growth question.
- **Crash consistency by idempotence, not step atomicity.** Interpretation
  is deterministic over `(ledger version, deliveryId)`: the step does
  read → interpret → write(CAS) → effects; a crash after the write retries,
  the CAS conflicts, the re-read hits tombstones and held-candidate dedupe,
  and the same effects re-derive. "State before effects" (invariant 8)
  holds verbatim, pointed at the store.

What stays in the session snapshot: `approvedTools` (policy input),
emission state, history — transcript and configuration, not request state.
`input_required` task views stop being separately journaled and derive from
`openRows`.

## Owners and mid-task HITL

The interpreter delivers settlement/dismissal payloads to `row.owner` over
the existing session-inbox envelope; what the consumer does is its own
business. Session turn and framework gate reproduce today's behavior. The
new owner class is the **tool-body run**: a background tool whose `execute`
is a workflow function opens rows and awaits them —

```ts
async execute(input, ctx: WorkflowToolContext) {
  "use workflow";
  const plan = await buildPlan(input);
  const decision = await Promise.race([
    ctx.request({ id: "approve-plan", kind: "approval", prompt, options }),
    ctx.sleep("4h").then(() => ({ optionId: "abort" })),
  ]);
  if (decision.optionId === "abort") return { status: "aborted" };
  const token = await ctx.auth("acme"); // Challenge row, same interpreter
  return applyPlan(plan, token);
}
```

- No new variants or verdicts: `ctx.request` opens a Question/Approval row
  with the body run's inbox as owner; `ctx.auth` opens a Challenge row and
  replaces the signal-return park for workflow tools (plain tools keep
  re-entrant `requestAuthorization`; only their representation unifies).
- Task-backed only: a receipt already settled the model-facing call, so the
  session stays receptive while the body parks.
- `.url` on the handle is a capability alias (`POST eve/v1/task-input/:token`)
  resuming anonymously (`responder: null` — the response policy decides if
  that is acceptable); identity-bearing paths forward the verified responder
  unchanged. The parent projects body-owned rows through the existing route
  machine; the task shows `input_required` while rows are open.
- #1224's "no blocked continuation anywhere" becomes an owner-contract
  clause: every waiting frame must be force-resumable from row state alone.
  The body `await` qualifies because forced closure rejects the promise
  (running `finally`); the historical wedges were waits only one specific
  input could release.

## Catalog coverage

Every #1224 transition row lands in exactly one place: the four reducers
encode their `owner.{approval,question,limit,auth}.*` families completely
(including pend-authorization with same-pass re-feed and
settle-cancel-pending-candidate); the interpreter encodes `owner.batch.*`
and cancellation rows once for all variants. Projection
(`projector.route.*`) and scheduler admission are inherited from #1224
unchanged — this proposal does not touch them. Park-side rows
(`park.persist-with-runtime-action`, `park.fail-closed-metadata`) stay in
the harness park path; compound-delivery sequencing is the
`translateEffects` contract, with responses-before-message guaranteed by
pass order.

## Migration

| Legacy | Destination |
| --- | --- |
| `eve.runtime.pendingInputBatches` | groups + Approval/Question rows; `responseMessages` → continuation payload |
| `eve.runtime.deferredStepInput` | deleted as a mechanism (per #1224); wedged messages release as ordinary turns |
| `eve.runtime.pendingAuthorization` | Challenge rows in one group; journaled `resume` → continuation payload |
| `eve.runtime.hitl.approvalState` | interpreter candidate records and tombstones |
| `eve.runtime.hitl.approvedTools` | unchanged — policy input, not request state |
| task `task:authorization:*` synthetic ids | deleted; a child's challenge is a real row, projected as a route |

One-shot migration on first load per session: read the legacy session-state
keys, write ledger v1 to the store (`ledgerFromSessionState` is the import),
drop the keys from the snapshot. No dual-write period. Wire untouched:
`InputRequest`/`InputResponse`, request ids, and capability URLs survive
byte-identically. One scoped break shared with #1224: pre-cutover challenge
URLs embed the old `${sessionId}:auth` token.

## Sequencing

Refinement of #1224's staged plan, not a competitor; the transition catalog
and its eval anchors remain the conformance suite, re-anchored by axis
(interpreter rows proven once, variant rows per variant, composites as
unions).

1. **Interpreter + variants** — #1224 stages 1–3 with the variant split.
2. **Body-run owner** — new executor kind on the task child wire;
   `ctx.request` / `ctx.auth`; responder forwarding on the task input wire
   (additive). Depends on workflow functions as `defineTool.execute`
   (subagents-as-workflow-tools research, §6.1).
3. **Gate unification** — the framework approval gate re-expressed as
   interpreter rows (representation change; step-end mechanics retained).

## Open questions

1. **Async `resolve` vs. pure interpreter** — policy evaluation inside the
   reducer trades #1224's strict purity in one place; the alternative
   (pre-resolved policy as input) doubles the input alphabet. Decide at
   stage-2 extraction.
2. **Deployment pinning for parked bodies** — multi-hour parks across
   redeploys are the common case; the pinning policy must be public before
   the authoring surface ships.
3. **Ledger retention** — moving blobs out of the ledger and deriving task
   views from `openRows` closes the growth problem, but tombstones are
   retained "until session end" (#1224) and long-lived sessions need a
   stated retention rule for terminal rows and settled groups.
4. **Foreground workflow tools** — `ctx.request` is task-backed only; the
   foreground example in the subagents research should be scoped to
   receipts.
