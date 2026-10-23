---
issue: https://github.com/vercel/eve/issues/1224
status: draft
last_updated: "2026-08-31"
---

# HITL requests: one durable lifecycle, independent request kinds

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
| approval attempts + response policies | `harness/approval-delivery-coordinator.ts`, `harness/approval-attempts.ts` |
| limit prompt creation + resolution special cases | `harness/session-limit-*.ts` |
| authorization storage + callback pairing | `harness/authorization.ts`, `execution/workflow-steps.ts` |
| projection routing | `harness/proxy-input-requests.ts`, `execution/subagent-hitl-proxy.ts` |

#1224 proposes the fix: one obligation state machine, one pure interpreter,
everything else an adapter. This doc refines that target with one more split —
**the interpreter owns the shared lifecycle while each request kind keeps its own reducer** — and adds an owner axis that turns the same machine into a
user-facing capability: tools that park on human input mid-task.

## The factoring

Two independent axes, entangled today:

- **Kind** — _what is owed_: response-handling rules and outcomes. Approval,
  Question, and Limit are framework request kinds. Authorization is an
  internal request kind used while checking an Approval response.
- **Owner** — _who waits_: the parked session turn, the framework approval
  gate, or later a durable tool-body run. The owner is stored once on the
  group created for that parked operation.

```text
                  ┌────────────────────────────────────┐
 request kinds ──▶│             INTERPRETER            │◀── group owner
 (what is owed)   │ requests · groups · response tries │    (who waits)
                  │ staleness · forced closure         │
 approval         │ ordering · group completion       │    session turn
 question         │                                    │    framework gate
 limit            │                                    │    tool-body run (later)
 authorization    └────────────────────────────────────┘
```

The persisted facts are deliberately small:

- **Request** — one durable question awaiting an outcome.
- **Group** — requests created by one parked operation, its owner, and whether
  completion still needs delivery.
- **Response attempt** — only when an Approval response is waiting on an
  Authorization request; identified by `{requestId, deliveryId}`.

The interpreter owns shared transitions over those facts. Each request kind
has one reducer—`resolve(request, input) → verdict`—unaware of parks,
sessions, batches, or other reducers. #1224's invariant 10 ("composite states
add no cases") becomes structural: mixed groups are the request-wise union.

A compiling prototype lives in [`hitl-requests/`](./hitl-requests/):

- `interpret.ts` — the pass: staleness → attempt identity → reducer
  dispatch → verdict application → group completion; `closeForced`; `createRequests`
  (intent dedup)
- `reducers/{approval,question,limit,authorization}.ts` — the complete rule set
  for each #1224 catalog family, one file each
- `ledger.ts` — derivation from the existing batch state (the migration
  import)
- `store.ts` — consistent storage: `read` / CAS `write`, blobs held apart
- `call-site.ts` — the `tool-loop.ts` integration point, unchanged
- `types.ts` — requests, groups, response attempts, inputs, and verdicts

## Model

```ts
interface Request<Spec> {
  id: RequestId;
  kind: "approval" | "question" | "limit" | "authorization";
  spec: Spec; // kind-owned durable facts
  groupId: GroupId;
  state: "open" | "settled" | "dismissed";
}

interface Group {
  id: GroupId;
  owner: string; // parked operation to notify
  completion: "waiting" | "ready" | "delivered" | "cancelled";
}

interface ResponseAttempt {
  requestId: RequestId;
  deliveryId: string;
  authorizationRequestId: RequestId;
  response: InputResponse;
}
```

A group replaces today's batch as the set of requests created by one parked
operation. Its withheld `responseMessages` are an owner-completion payload,
stored beside the hot request state. When every request is terminal, completion
moves from `waiting` to `ready`. A `ready` group is delivered idempotently and
remains retryable across crashes; only successful delivery acknowledges it as
`delivered`. Forced closure moves it to `cancelled`.

Terminal requests remain available long enough to distinguish a stale response
from an unknown request id. There is no separate tombstone type or collection.

Boundary rules — each one deletes a module from the table above:

- **Staleness is interpreter-side** — a response naming a terminal request
  rejects against the retained terminal request before any reducer runs (`stale` for
  retained terminal requests, `invalid` for unknown ids). Deletes
  `stale-input-responses.ts`. The one per-kind setting is visibility:
  Limit drops stale answers silently; others produce a context turn.
- **Races are interpreter-side** — attempt identity is
  `{requestId, deliveryId}`; single-winner before `resolve`; redeliveries
  reuse held attempts. Absorbs `approval-attempts.ts`.
- **Classification is the request kind.** Deletes
  `input-request-class.ts` — "text never settles an approval" is the
  approval reducer returning `"ignore"` for non-responses, one line.
- **The reducer never sees text.** Message inputs carry only the actor
  relation, so text-matching against open requests is unrepresentable.
- **`blockOn`/`linked` is the one cross-kind edge** — a reducer parks a
  attempt on another request reaching terminal (approval's
  needs-auth), naming a request it wants terminal, never the other request kind's
  rules. Held attempts settle-cancel and dedupe interpreter-side.
- **`resolve` may be async** — authored approval policies run inside it,
  step-wrapped; throw/timeout becomes `policy-failed` with the request open.
  This deviates from #1224's strictly pure `interpretHitl` (open question 1).

## Dynamic approval policies

Approval policies are authored code, and dynamic tools exist only in the
steps that advertised them — a policy function cannot be persisted with a
request. Specs store durable facts only (the gated `action`, the computed
`approvalKey` string, and `responseAuthRequired`: "this tool had a response
policy when it asked" — today's `responseAuthRequiredRequestIds`). The
policy is late-bound every pass from the live `HarnessToolMap`
(`call-site.ts:bindApprovalPolicy` — the `authorizeCandidate` lookup at
`approval-delivery-coordinator.ts:334`, generalized). When the lookup finds
nothing (ephemeral tool, redeploy), the park-time flag decides: no policy
ever required → settle directly; policy required but unavailable → fail
closed with `policy-failed`, request stays open and answerable after a redeploy.

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
(`appendPendingInputBatch` → consumed by `createRequests`), same result contract.
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
Derived reads (`openRequests`) are pure functions over the ledger, not store
methods, so backends cannot diverge on query semantics. Backend selection is
an implementation decision; this proposal defines only the eve-owned read,
conditional-write, and conflict contract.

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
- **Scope is the root session id.** Body-run requests live under their root
  session's scope — the parent projection reads them — never under the
  run's own id.
- **Blobs live beside the ledger, not in it.** A group's owner-completion payload (the withheld model output) is a
  separate record written once when the group is created; `read` returns
  requests, groups, and response attempts only. This closes most of the journal-growth question.
- **Crash consistency by retryable delivery, not an in-memory claim.** The
  interpreter persists a completed group as `ready` before delivery. Every
  pass re-emits delivery for `ready` groups. The owner handles delivery
  idempotently; only success writes `delivered`. A crash between the first
  write and owner delivery therefore retries instead of losing the resume.
  "State before effects" (invariant 8) still holds.

What stays in the session snapshot: `approvedTools` (policy input),
emission state, history — transcript and configuration, not request state.
`input_required` task views stop being separately journaled and derive from
`openRequests`.

## Owners and mid-task HITL

The interpreter delivers a ready Group to `group.owner` over the existing
session-inbox envelope. The owner handles that delivery idempotently and the
interpreter acknowledges it as `delivered` only after success. Session turn and framework gate reproduce today's behavior. The
new owner class is the **tool-body run**: a background tool whose `execute`
is a workflow function opens requests and awaits them —

```ts
async execute(input, ctx: WorkflowToolContext) {
  "use workflow";
  const plan = await buildPlan(input);
  const decision = await Promise.race([
    ctx.request({ id: "approve-plan", kind: "approval", prompt, options }),
    ctx.sleep("4h").then(() => ({ optionId: "abort" })),
  ]);
  if (decision.optionId === "abort") return { status: "aborted" };
  const token = await ctx.auth("acme"); // Authorization request, same interpreter
  return applyPlan(plan, token);
}
```

- No new request kinds or verdicts: `ctx.request` opens a Question/Approval request
  in a Group owned by the body run; `ctx.auth` creates an Authorization request and
  replaces the signal-return park for workflow tools (plain tools keep
  re-entrant `requestAuthorization`; only their representation unifies).
- Task-backed only: a receipt already settled the model-facing call, so the
  session stays receptive while the body parks.
- `.url` on the handle is a capability alias (`POST eve/v1/task-input/:token`)
  resuming anonymously (`responder: null` — the response policy decides if
  that is acceptable); identity-bearing paths forward the verified responder
  unchanged. The parent projects body-owned requests through the existing route
  machine; the task shows `input_required` while requests are open.
- #1224's "no blocked continuation anywhere" becomes an owner-contract
  clause: every waiting frame must be force-resumable from request state alone.
  The body `await` qualifies because forced closure rejects the promise
  (running `finally`); the historical wedges were waits only one specific
  input could release.

## Catalog coverage

Every #1224 transition request lands in exactly one place: the four reducers
encode their `owner.{approval,question,limit,auth}.*` families completely
(including pend-authorization with same-pass re-feed and
settle-cancel-pending-attempt); the interpreter encodes `owner.batch.*`
and cancellation requests once for all request kinds. Projection
(`projector.route.*`) and scheduler admission are inherited from #1224
unchanged — this proposal does not touch them. Park-side requests
(`park.persist-with-runtime-action`, `park.fail-closed-metadata`) stay in
the harness park path; compound-delivery sequencing is the
`translateEffects` contract, with responses-before-message guaranteed by
pass order.

## Migration

| Legacy | Destination |
| --- | --- |
| `eve.runtime.pendingInputBatches` | groups + Approval/Question requests; `responseMessages` → owner-completion payload |
| `eve.runtime.deferredStepInput` | deleted as a mechanism (per #1224); wedged messages release as ordinary turns |
| `eve.runtime.pendingAuthorization` | Authorization requests in one group; journaled `resume` → owner-completion payload |
| `eve.runtime.hitl.approvalState` | interpreter attempt records and retained terminal requests |
| `eve.runtime.hitl.approvedTools` | unchanged — policy input, not request state |
| task `task:authorization:*` synthetic ids | deleted; a child's authorization is a real request, projected as a route |

One-shot migration on first load per session: read the legacy session-state
keys, write ledger v1 to the store (`ledgerFromSessionState` is the import),
drop the keys from the snapshot. No dual-write period. Wire untouched:
`InputRequest`/`InputResponse`, request ids, and capability URLs survive
byte-identically. One scoped break shared with #1224: pre-cutover authorization
URLs embed the old `${sessionId}:auth` token.

## Sequencing

Refinement of #1224's staged plan, not a competitor; its transition catalog
remains the conformance suite.

1. Characterize current behavior and intended #1224 changes.
2. Make the ledger, `createRequests`, interpreter, Approval, Question, Limit,
   groups, and migration authoritative together.
3. Move response attempts, live approval policies, and internal Authorization
   requests into the interpreter.
4. Migrate the framework approval gate as the final existing owner.
5. Only after the framework is fully migrated, build workflow-backed tool
   execution and the public tool-body owner (`ctx.request` / `ctx.auth`).

## Open questions

1. **Async `resolve` vs. pure interpreter** — policy evaluation inside the
   reducer trades #1224's strict purity in one place; the alternative
   (pre-resolved policy as input) doubles the input alphabet. Decide at
   stage-2 extraction.
2. **Deployment pinning for parked bodies** — multi-hour parks across
   redeploys are the common case; the pinning policy must be public before
   the authoring surface ships.
3. **Ledger retention** — moving blobs out of the ledger and deriving task
   views from `openRequests` closes the growth problem, but retained terminal requests are
   retained "until session end" (#1224) and long-lived sessions need a
   stated retention rule for terminal requests and settled groups.
4. **Foreground workflow tools** — `ctx.request` is task-backed only; the
   foreground example in the subagents research should be scoped to
   receipts.
