---
issue: https://github.com/vercel/eve/issues/1673
status: proposed
last_updated: "2026-09-28"
---

# Run observation sidecar and declarative Slack rendering spike

> **AI status:** Written entirely by AI; human review pending.

## 1. Goal and decision

Build an opt-in, independently executing sidecar that reads existing durable session streams, reduces them with the same conversation reducer as web/TUI, and owns Slack presentation through a small desired-state reconciler.

This is a spike to prove the architecture, not a production replacement for every channel. It adds no producer-side event-forwarding protocol, no parent progress inbox, and no new execution-state journal. Existing streams remain the source history. The sidecar retains its observation projection and provider-delivery state through Workflow checkpoints.

```text
root execution -------------------> existing durable root stream
child/remote execution -----------> existing durable child streams
                                                |
                                      bounded cursor-based reads
                                                |
                                  ONE run-observation workflow
                                  +-------------------------------+
                                  | observation branch            |
                                  |   discover / read / reduce     |
                                  |   checkpoint cursors + state   |
                                  |              |                |
                                  |      desired Slack objects     |
                                  |              |                |
                                  | delivery branch               |
                                  |   plan / apply / record result |
                                  +-------------------------------+
                                                |
                                             Slack API
```

The two branches must advance independently. Do not implement a serial `poll → await all Slack writes → poll` loop. Do not introduce React, JSX, a virtual DOM, or a rendering dependency: use plain eve-owned TypeScript data and a pure diff function.

This spike chooses declarative reconciliation as a bounded experiment; it is not a prerequisite for every future run-observation implementation.

## 2. Decisions the implementer must preserve

1. **No presentation-only wake of the parent workflow.** No progress commands, periodic parent steps, or reducer work in the parent. A one-time sidecar launch during session initialization is allowed.
2. **No model call from the sidecar.** Rendering is code, not an agent summarizing its own logs.
3. **Existing execution handlers and hooks keep their execution semantics.** The opt-in moves built-in Slack presentation, not arbitrary application callbacks, memory hooks, dynamic resolvers, or execution authorization.
4. **One writer for each managed Slack object.** In enabled sessions, legacy outbound handlers and the old activity collector must not also render it.
5. **Same reducer, different transport owner.** Reuse Owen's pure conversation/message lifecycle logic; do not instantiate a browser store inside a durable workflow or fork the reducer.
6. **Source cursor and projected state checkpoint together.** Never persist an advanced cursor without the state that consumed its records.
7. **Observation and delivery are distinct.** A failed Slack write does not discard source events or turn execution failure into success. A remote read failure does not mean the remote agent failed.
8. **No implicit exactly-once claim.** Ambiguous provider creates require recovery or a visible blocked delivery state, not blind retries.
9. **No silent unsupported behavior.** Narrow fixture milestones are allowed, but the general opt-in cannot advertise support for approvals/auth/files/proactive sends until their gates pass.
10. **No automatic fallback to legacy posting.** Once a session chooses observation ownership, a sidecar failure must not create a second writer.

## 3. Baseline and prerequisites

### 3.1 Do not implement against the wrong protocol

The original investigation used eve `bbe79f4d955e72d5e325607fa85ac987bdf175e4`. Owen's newer stack is built on a tasks rewrite and changes event semantics. At research time these PRs were open:

| Dependency | Inspected revision                         | Use                                               |
| ---------- | ------------------------------------------ | ------------------------------------------------- |
| #3878      | `047caac7644de75ee5013a26a468443d04681250` | Stable text/reasoning part IDs and message fixes. |
| #3879      | `72aab0f5096e07af93d1a5f584123f17f13e64ea` | Conversation reducer/state, transport follower.   |
| #3880      | `faf6dcf54d117943e3b08ec64f1bb5f520192960` | TUI as a consumer of the shared store/model.      |
| #3922      | `8b6a45352dd42ab77994313ec3c92e5bab24377d` | Explanation and known gaps.                       |

Before editing, record the actual base SHA, stream version, and dependency status in implementation notes. Prefer the merged equivalent; otherwise work on an explicitly approved branch based on the complete stack and its tasks dependency. **Do not cherry-pick only the reducer into the old execution protocol.** Do not build a legacy compatibility layer for this spike.

Expected new protocol: `agent.started`, `task.started`, `task.settled`, and `session.agent(started).stream()`. Baseline equivalents such as `subagent.called` and `streamSubagent()` appear in older source references below; inspect their new owners rather than blindly retaining those names.

### 3.2 Read these owners first

Paths below are under `packages/eve/src/`; locate renamed equivalents on the chosen base.

| Owner                     | Relevant files                                                                                            | What to learn                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Shared semantics          | `client/conversation-state.ts`, `conversation-reducer.ts`, `message-reducer.ts`, `message-run-parts.ts`   | Pure state transition API, stable keys, authorizations, task/agent identity.                                          |
| Existing client transport | `client/conversation-client.ts`, `agent-stream-follower.ts`, `agent-session.ts`, `open-stream.ts`         | Discovery, independent child cursors, caught-up rules, bounded reads. Do not copy client lifetime/optimism machinery. |
| Current sidecar           | `execution/activity-collector.ts`, `session-activity-renderer-step.ts`, `workflow-runtime.ts`             | Registration, startup, deployment ownership, durable sleep and cleanup.                                               |
| Execution dispatch        | `execution/session/event-sink.ts`, `publish-channel-event.ts`, `channel/adapter.ts`                       | Handler-before-write ordering, routing/suppression, state updates.                                                    |
| Slack                     | `public/channels/slack/slackChannel.ts`, `defaults.ts`, `api.ts`, `activity.ts`, `activity-plan.ts`       | Default overrides, private interactions, destination/anchor mutations, provider recovery.                             |
| Server-side stream access | `channel/session.ts`, `execution/workflow-runtime.ts`, `eve-channel/request.ts`, `eve-channel/support.ts` | `getEventStream`, captured tails, cancellation, remote binding lookup.                                                |

Also read root `AGENTS.md`, the test-audit skill, published Slack/custom-channel docs, and `e2e/README.md`. All runtime implementation stays in the `eve` package; compiler-generated code only registers/imports it.

### 3.3 Required capability audit — first deliverable

Produce a small table for every existing built-in outbound path: triggering event, payload needed, target visibility, state mutated, provider operation, proposed owner. Cover replies, statuses, errors, questions, approvals, authorization challenges/completion, private candidate notices, files, and proactive anchors. Include ingress calls, not just the `events` map.

**Stop and ask for review** if a renderer-critical fact exists only in live callback context. The new sidecar cannot reconstruct current principal, private responder routing, candidate identity, or original provider destination merely from message text. Resolve each missing fact by extracting an existing durable source or adding a narrowly scoped durable delivery-context record. Such a record is not an all-events push lane; it is explicit presentation metadata persisted with the existing lifecycle. Never copy secrets into the public stream.

## 4. Spike scope and rollout gates

### 4.1 First executable slice

Use a deterministic Slack test fixture with an existing thread and known installation. Support:

- Root user messages as input history, not reposted as new Slack messages.
- Completed root assistant text, including multiple blocks/replies in a turn.
- One updated activity card per root turn with direct-child task status and safe labels.
- Root failure/cancellation presentation and final status cleanup.
- Direct local and direct remote task-backed child observation.
- Sidecar restart, duplicate records, reconnect, and provider retry/unknown outcomes.

This slice is **fixture-only**, not the release-ready channel opt-in. It may use a known destination and omit interactive tools by fixture construction. Runtime encounters with unsupported interaction events must produce a diagnostic delivery failure, not silently fall back to old posting.

### 4.2 Follow-up gates, not part of the first spike

**Packages A–F and measurement package H define the spike. Package G below is a separately reviewed follow-up.** Completing the fixture is not permission to expose a general channel opt-in. Before offering that opt-in outside controlled fixtures, add:

- Questions and approvals, including private approval routing and removal of stale controls.
- Authorization UI with correct recipient privacy and attempt identity.
- Native long-reply/file handling; multiple-message layout with bounded payloads.
- Proactive thread-anchor creation and route/alias association.
- New-session opt-in ownership, inactive/parked lifetime, and deployment/expiry behavior.
- A documented matrix of supported descendants and explicit unavailable/unsupported states.

Nested local descendants are a planned stretch after direct-child correctness. Arbitrary remote-of-remote traversal is **not** an accidental recursive URL fetch: it needs an authorized origin-aware route. Mark unsupported nested access explicitly for this spike; do not claim a complete global log.

### 4.3 Explicit non-goals

- Replacing execution checkpoints, task settlement, or approval decisions.
- Replacing web/TUI transports or exposing a stable public observation API in this spike.
- A second permanent raw-event archive or universal cross-agent total ordering.
- General plugin/React component APIs or native Slack plan streaming in the first slice.
- Migrating application-specific business logic, every third-party channel, or existing sessions.
- Solving provider-attempt identity missing from the underlying protocol. Surface the limitation; do not invent an attempt ID from text equality.

## 5. Proposed authoring and ownership contract

**The names in this section are proposed, not existing APIs.** Keep one experimental switch and one built-in renderer first; avoid exposing tuning knobs prematurely.

```ts
// Proposed shape; finalize naming with a maintainer before publishing.
slackChannel({
  experimental: {
    runObservation: true,
  },
});
```

If the current factory already has an experimental namespace, extend it; otherwise approve the shape before coding. Do not add both a top-level alias and an experimental alias.

Configuration rules:

- Default off: existing Slack behavior and existing activity opt-in remain unchanged.
- On: new sessions have observation-owned presentation; no old activity collector starts for them, and no built-in outbound event handler writes Slack.
- Initially reject any `events` overrides together with this opt-in. Arbitrary mixed logic cannot be moved safely. A later explicit execution-only override API is separate work.
- The fixture mode also rejects custom inbound hooks and private approval configuration. Enable only the audited stock ingress paths and a fixture allow-list with no interactive tools or proactive receives. Do not export/install the experimental factory in the normal channel registry until package G's admission contract is approved.
- Reject simultaneous old `activity.renderers` configuration.
- Custom ingress hooks remain execution/ingress code, but direct provider posts from them are outside managed presentation. Document that they can conflict; no framework can automatically intercept arbitrary user fetches.
- The mode is pinned at session creation. No hot migration from old to new or vice versa.

Do not make `writeChannelEvent()` skip all adapter behavior globally. Disable/extract outbound behavior at the Slack factory boundary. Default inbound “Thinking…”/typing posts are presentation too: suppress or move them in enabled mode. Keep only transport-required acknowledgements at ingress; do not leave a second status writer behind. Preserve route authentication, delivery normalization, audience classification, command handling, and execution-relevant state. A narrowly scoped presentation metadata seam is allowed if the audit proves it necessary.

## 6. Component layout and contracts

Use a cohesive directory such as `execution/run-observation/` for server ownership and `public/channels/slack/observation/` for Slack-specific projection/delivery. These paths are recommendations; follow the chosen base's compiler and file-size conventions.

| Component                | Responsibility                                                                    | Must not do                                                            |
| ------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `workflow.ts`            | Single logical owner, durable scheduling, current observation and delivery state. | Model calls, unbounded HTTP reads, provider logic in reducer.          |
| `read-step.ts`           | Bounded source pages; runtime/HTTP access; fresh credential resolution.           | Mutate parent session, execute child work, swallow cursor gaps.        |
| `state.ts` / `reduce.ts` | Serializable source registry and application of the shared reducer.               | Fork lifecycle semantics or include browser optimism.                  |
| `slack/view.ts`          | Pure projection to keyed desired provider objects.                                | Fetch, clock reads, random IDs, secret lookup.                         |
| `slack/plan.ts`          | Pure diff between desired state and confirmed/pending delivery records.           | Slack calls or deleting unspecified historical messages.               |
| `slack/apply-step.ts`    | One bounded provider operation or recovery lookup and typed outcome.              | Internal long sleeps, infinite retries, mutation of observation state. |
| Startup/registry glue    | Launch, claim ownership, pin mode and sidecar identity.                           | Polling or rendering from parent control loop.                         |

Do not put these functions in authored/generated agent source. Reuse existing Slack transport and credential resolution; do not add another Slack SDK or runtime dependency.

### 6.1 Serializable observation state

Use plain records/arrays, no live `Client`, controller, stream, function, `Map`, or provider token in persisted state. Illustrative internal shape:

```ts
interface ObservationState {
  version: 1;
  rootSessionId: string;
  revision: number;
  sources: Record<string, SourceState>;
  sourceOrder: string[];
  // Default conversation state per source; reuse the shared reducer.
  conversations: Record<string, ConversationState>;
  diagnostics: ObservationDiagnostic[];
}

interface SourceState {
  sourceKey: string; // origin/delegation identity + session, not bare remote ID
  sessionId: string;
  parentSourceKey?: string;
  parentCallId?: string;
  taskId?: string;
  locator: SourceLocator; // validated local or parent-bound remote locator
  nextIndex: number; // next source record, never an event-ID cursor
  capturedTail?: number;
  state: "following" | "caught-up" | "unavailable" | "unsupported";
  nextPollAt: string;
}
```

Derive root/child links from recorded delegation facts. A session ID from an unrelated origin is not globally unique. Do not treat descendant `turn.completed` as parent completion.

Prefer the existing canonical child-observation event adapter for direct children if it meets serialization requirements. If recursive state later needs a path, add a generic pure path-update helper around the **same** reducer; do not add a second switch statement interpreting lifecycle events.

### 6.2 Reducer reuse gate

Before transport work, prove:

1. Reducing a fixed event sequence gives the same state as the client reducer.
2. Reducing a prefix, JSON-round-tripping its state, then reducing the suffix gives the same result as uninterrupted reduction.
3. Partial text/reasoning, open input, pending authorization, multiple task calls, and child observations survive that boundary.
4. Stable part IDs remain unchanged across snapshot/restart.

If the reducer relies on process-local identity or hidden caches, make that state explicit in the shared implementation with owner-boundary tests. Do not serialize a `ConversationClient` or replay an ever-growing in-memory event array on every poll.

**Known projection gap:** at the inspected Owen commit, `message.completed` is reduced to text-part completion without retaining its `finishReason`; cancellation/failure can also mark partial text done. Therefore `part.state === "done"` does not mean “post a final Slack reply.” Preserve explicit completion provenance in the shared message model, or add a small server-event-derived presentation-facts record keyed to the same stable part IDs. Record the distinction between a completed visible reply, tool-call narration, and a cancelled/failed draft. This is additive provenance, not a second lifecycle reducer. Include it in checkpoint parity tests and never infer it from text or the latest step outcome.

Browser optimistic submissions and `client.input.responded` are not authoritative source facts. Server observation marks input answered only when execution accepts/settles it; a local Slack acknowledgement is delivery/interaction state, not approval.

## 7. Launch and lifecycle

### 7.1 One-time startup

Reuse the activity sidecar's Workflow registration/start pattern, but give the new workflow a distinct stable name/version. Do not repurpose the existing `activityCollectorWorkflow` ID for a different input/state contract; old sessions may still execute it.

Launch once from session initialization, after root stream identity and channel initialization are available and before managed output can be missed. Reading from index zero means the sidecar may start after the first records without losing them. If the chosen runtime creates the root ID only on entry, use one parent initialization step; do not repeatedly dispatch parent commands to launch/recover it.

A retry of that startup step can create duplicate runs. For the fixture, use the same primitives as the current collector: `createHook` with one stable root-session/presentation-owner token, followed by `claimHookOwnership`; retain the hook until the owner exits and treat `isHookConflictError` as a loser exit. Derive the token deterministically from the stable anchor session ID plus renderer version using the existing reserved-token convention, not a fresh random token on every retry. Do not expose a public event-ingestion endpoint for this ownership hook. Verify that the selected runtime's hook claim is exclusive across duplicate starts before proceeding. Only the claimant may poll/deliver; losers exit before provider writes. Establish how the launcher knows the claim is ready, and bound the wait. Do not assume that holding an in-memory flag establishes ownership across processes.

Persist the selected mode, sidecar run ID/owner identity, and schema version in the existing supported session-start state. The field must survive redeployment handoff. Collector startup failure must be explicit: no silent legacy fallback. In a fixture it fails admission with a clear diagnostic; general rollout needs an operator-visible failed presentation state and recovery policy.

### 7.2 Lifetime

- Poll the root even while it is waiting for another user message; waiting is not session completion.
- A settled direct-child task may pause its child reader according to the shared caught-up rule. A later call resumes from its saved cursor.
- On root terminal outcome, finish a final bounded catch-up and attempt pending mandatory deliveries within the remaining budget. Unknown/permanently blocked effects remain explicitly undelivered in the recorded ledger; terminal execution is not delivery success. Do not infer EOF from a timed-out reader.
- Reset/cancellation semantics must come from execution events; stopping the observer never cancels execution.
- For the fixture spike, cap sidecar lifetime at **60 minutes** and record explicit expiry. Stop transient status best-effort; retain historical messages. This is a test/experiment bound, not a silently enabled limit for real multi-day sessions.
- General opt-in remains blocked until lifetime/renewal covers the admitted session/task lifetime. Do not inherit today's arbitrary 24-hour activity fallback without a product decision.
- Preserve stopped/failed delivery diagnostics outside transient Slack status. A quiet vanished worker must be observable through its Workflow run and recorded state.

No restart/lease-takeover facility is required for the first fixture beyond Workflow's own retry/replay. If implementing replacement owners, require fencing; never let an old worker continue updating provider objects after takeover.

## 8. Polling algorithm

### 8.1 Read one bounded page

Use a Workflow step for I/O. Local baseline APIs are `Session.getStreamTailIndex()` and `Session.getEventStream({ startIndex })`, backed by Workflow chunk indexes (one normalized event per source chunk). For remote reads, the existing parent-bound stream endpoint accepts `startIndex` and `includeTailIndex=1`; `x-eve-stream-tail-index` supplies the bounded tail. On Owen's base, `session.agent(started).stream({ startIndex, follow: false })` wraps that contract. Verify that the selected branch retains those semantics and stream normalization before coding. Prefer local runtime access over loopback HTTP. Reuse the remote binding/resolver rules and resolve fresh credentials; do not persist bearer headers or accept arbitrary event-supplied URLs for privileged fetches.

For each source:

1. Capture its current durable tail.
2. If `nextIndex > tail`, return an empty successful page without opening a follow-forever reader.
3. Read from `nextIndex`, stopping at the earlier of captured tail, page event cap, byte cap, or deadline.
4. Parse/normalize with the existing stream-version logic. Count source records, not reducer changes.
5. Return complete records plus their source positions, next index, captured tail, and an explicit read outcome.
6. Always cancel/release readers in `finally`, including empty/capped/aborted reads.

Do not use the root/child stream as an unbounded `for await` inside a durable step. Do not use tail-relative cursors for recovery. Do not create a snapshot/live gap by substituting event IDs for source positions.

### 8.2 Apply a poll result

One observation branch owns this mutation:

1. Apply sources in deterministic registry order, preserving record order within each source. Cross-source order is observation order, not a physical global clock.
2. Deduplicate rereads by source position; retained event IDs can defend actual repeated records but are not retry-intent IDs. Advance the read cursor even for an event ignored by the reducer.
3. Apply each accepted event to that source's shared conversation reducer.
4. Register newly observed children idempotently with their parent/call/task context.
5. Publish the updated child observation into root canonical state where supported.
6. Use a journaled reduce/checkpoint step returning cursor changes, reducer state, discovery, and presentation provenance as one serializable result. Pure reducer functions are reusable inside that step; the wrapper owns durability. Do not publish the new revision to the delivery branch until this result is accepted. A read result recorded by Workflow replay must be applied exactly as recorded, not refetched during deterministic replay.
7. Increment observation revision only for meaningful observable state changes, not every empty poll.

If a read fails mid-page, return/apply only its complete validated prefix, assigning positions from the requested absolute index plus records decoded. An incomplete trailing JSON record is not consumed. If the adapter cannot prove that prefix, return no records and retry the unchanged cursor. A read-step retry before a journaled result may reread; no cursor moves until the reduce/checkpoint result is accepted. Completed read/checkpoint steps replay recorded results.

A growing tail during the read belongs to the next page. A successful captured tail below the saved cursor does not justify rewinding: diagnose a source reset/retention inconsistency unless the cursor is exactly the next position after tail. Missing tail headers fail bounded remote reads. The current API may not report every form of history truncation; do not invent gap detection it cannot support. Mark completeness unverified when retention semantics are not established. Model-context compaction is not assumed to delete or renumber stream history. Unsupported versions and unavailable retained history remain explicit diagnostics; never skip to the tail.

### 8.3 Initial internal limits

These are **starting budgets to measure**, not public API guarantees:

| Setting                     | Fixture default                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Active source polling       | Every 1 second, adjusted for work already in flight.                                                                                            |
| Quiet root polling          | Back off to 5 seconds; reset on new records.                                                                                                    |
| Concurrent source reads     | 4; root gets a slot every round, other sources round-robin.                                                                                     |
| Events per source page      | 200.                                                                                                                                            |
| Bytes per source page       | 512 KiB, enforced during reading where possible.                                                                                                |
| Read operation timeout      | 5 seconds.                                                                                                                                      |
| Registered sources          | 32; exceeded limit becomes explicit partial coverage.                                                                                           |
| Discovery depth             | Direct children first; later bounded local nesting up to 4.                                                                                     |
| Observation checkpoint      | 4 MiB serialized target cap; stop/admit narrowly rather than silently truncate required message history. Verify against actual Workflow limits. |
| Source-read failure backoff | 1, 2, 4, 8, then 30 seconds; keep diagnostic state.                                                                                             |

Enforce hard fixture admission limits of 10 root turns, 32 sources, 2,000 managed provider objects/receipts, and 100 retained diagnostics (old diagnostic text may roll off with an aggregate count). Before accepting a proposed checkpoint, measure its serialized size against the lesser of 4 MiB and the verified runtime limit. If it exceeds the budget, retain the last valid cursors/state and return a small terminal `capacity-exceeded` observation diagnostic; do not consume/truncate mandatory history. General sessions remain unsupported until bounded history/pagination or an external store is designed.

A single record larger than the cap must be reported as oversized, not partially applied or silently consumed. Fixtures should avoid it initially. Before production, implement authorized artifact references or a defined oversized-record policy. Root-priority scheduling must not starve children.

### 8.4 Single workflow, independent delivery

First prove this shape in package A against the actual Workflow runtime: start two ordinary async loops inside the workflow and await them with `Promise.all`, using only journaled step calls and durable `sleep` for external waits. Their state is disjoint; observation publishes only after an accepted checkpoint step, and delivery captures a revision before a provider step. There is no assumed automatic database transaction over a shared JS object. Test replay ordering, failure cleanup, and observation progress while delivery is suspended **before** implementing the larger feature. A maintainer must approve the proof; unsupported concurrency is a stop condition, not an implementation choice delegated to a junior.

The proposed branches are:

```text
observation loop                    delivery loop
----------------                    -------------
read bounded pages                  inspect latest committed desired revision
reduce/checkpoint                   choose next due operation
replace latest observation          perform one bounded provider step
sleep durably                       record result; compute next due time
                                    sleep durably, respecting Retry-After
```

Only observation mutates source cursors/conversations. Only delivery mutates the receipt/pending-operation ledger. The renderer reads a captured observation revision. After an awaited provider call, record what was actually applied; then reconcile against the newest revision, not a stale desired snapshot.

The delivery branch must not hold a lock needed by observation. Use Workflow's durable sleep, not `setInterval`, detached process promises, or a long `setTimeout` retry inside a step. Confirm that the selected Workflow runtime supports this concurrent-branch pattern and deterministically journals the awaited step completions. **If it cannot pass the slow-provider/fast-observation scenario, stop for design review; do not claim isolation or secretly add another worker.**

## 9. Pure Slack desired-state renderer

### 9.1 Minimal object model

Start with only persistent messages and assistant-thread status. Add interaction cards as messages later. Files and ephemeral notices need separate keyed operations; do not pretend they support the same update/recovery semantics.

```ts
interface DesiredSlackView {
  revision: number;
  messages: DesiredSlackMessage[]; // explicit stable creation order
  status: { text: string };
}

interface DesiredSlackMessage {
  key: string;
  kind: "reply" | "activity" | "input" | "authorization" | "error";
  visibility: "thread" | "private"; // private requires a trusted recipient binding
  text: string; // accessibility/fallback text
  blocks: readonly SlackBlock[]; // eve-owned validated subset, not arbitrary HTML
  lifecycle: "mutable" | "retained";
}
```

This is conceptual; reuse existing eve-owned Slack message/block types where possible. Required outputs must be deterministic and serializable. Include destination identity in the delivery key, not just the message key. Use the existing escaping/formatting and Slack limits utilities; do not expose reasoning/raw tool inputs by default.

Stable logical key examples:

- Reply: root source + turn + stable assistant text-part ID.
- Activity: root source + originating turn/work grouping.
- Input: owning source + request ID + approved presentation destination.
- Authorization: owning source + attempt ID + recipient scope.
- Error: canonical turn/session failure identity, avoiding duplicate cascade posts.

If required identity is absent, record unsupported identity; do not use random IDs, array indexes, timestamps, or content hashes as semantic identity. Content hashes are only for comparing content under an already-stable key.

### 9.2 Default projection rules

- Do not repost user inputs already present in Slack.
- Root finalized visible text becomes retained reply objects. Preserve multiple text runs; do not publish tool-call narration as final replies.
- First slice posts only completed text. Streaming edits can be added after create/update recovery works.
- Never flatten every child's assistant text into independent top-level replies. Summarize child status under the activity object; expose richer detail only by explicit renderer policy.
- Derive task outcomes from authoritative lifecycle state, not read freshness.
- Keep completed activity readable; mark blocked/failed/unknown observation distinctly.
- A root final reply must not unconditionally clear activity for outstanding work. Use the selected protocol's task/turn semantics.
- Text/blocks must satisfy Slack payload limits before effects. Long replies use the existing native file/snippet strategy once supported; do not truncate a mandatory answer silently.
- Open questions/approvals become cards; settled requests remove/disable controls through updated desired content. Use existing request/callback encoding, never a new approval decision mechanism.
- Private auth links/candidate details never enter public blocks. Use trusted recipient context only. Because source streams can suppress child interaction events after routing them to the parent, render the parent-owned actionable request once; child observations may show a noninteractive blocker but must not independently mint duplicate controls.

### 9.3 Omission is not deletion

The authoritative set means objects owned by this renderer, not the whole Slack thread. Never delete user/other-bot messages. Paging, context compaction, or a bounded view omitting old history must not delete historical replies.

The first slice has **no general delete operation**. Retain delivered replies; update known mutable objects; clear status explicitly. Add deletion only for a concrete supported lifecycle with a tested ownership boundary.

## 10. Durable reconciler

### 10.1 Delivery ledger

Keep destination-scoped records keyed by logical object ID. Suggested fields:

```ts
interface DeliveryRecord {
  key: string;
  desiredVersion: string; // deterministic fingerprint of provider payload
  appliedVersion?: string;
  providerMessageId?: string;
  state: "pending" | "confirmed" | "retryable" | "unknown" | "blocked";
  attempts: number;
  nextAttemptAt?: string;
  lastErrorCode?: string; // sanitized; no tokens or private payload logs
  pendingOperation?: PendingOperation;
}
```

Persist a planned operation before executing it, with a stable operation identity derived from owner/key/version/kind. Concretely, pass the planned operation/ledger transition through a journaled planning step (or a proven existing durable equivalent) and await that boundary before the provider step. An assignment to a workflow-body variable is not an independent committed outbox. Workflow replay alone does not make external effects transactional. Confirm the actual step checkpoint ordering with a crash scenario, not merely a mocked function-call assertion.

### 10.2 Pure planning rules

For each desired object:

1. No delivery record → plan create/recovery, not unconditional post.
2. Known provider ID, identical applied fingerprint → no-op.
3. Known provider ID, changed content → plan update to the latest desired version.
4. Pending retry but desired content changed → supersede stale updates; retain unresolved create identity.
5. Unknown create outcome → recovery first; do not issue another create automatically.
6. Missing desired historical reply → retain its receipt; no delete.
7. Status changed → set/clear status; renew an expiring active status on a due timer even if text is unchanged.

Mandatory replies/input UI take priority over activity, subject to required per-destination ordering. Coalesce intermediate activity versions. Do not coalesce away distinct completed messages or requests.

### 10.3 Effect application and outcomes

Reuse the configured Slack transport and resolve credentials at effect time. Apply one operation per step, with a finite network timeout and bounded response reads. Return a typed outcome:

| Outcome                                    | Next action                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed                                  | Record provider ID and exact applied fingerprint/revision.                                                                                        |
| Rate-limited                               | Record `Retry-After`; release work and wait durably. Observation continues.                                                                       |
| Retryable update failure                   | Bounded backoff; next attempt uses latest desired content.                                                                                        |
| Ambiguous create timeout/transport failure | Mark unknown and attempt bounded metadata recovery.                                                                                               |
| Permanent permission/validation failure    | Block delivery with actionable diagnostic; no legacy fallback.                                                                                    |
| Known message deleted                      | For an active managed mutable object, recover or explicitly recreate according to policy. Do not resurrect deleted historical replies by default. |

Use stable metadata/creation identifiers supported by the existing Slack wrapper and bounded `conversations.replies` recovery where authorized. Do **not** claim `client_msg_id` alone guarantees deduplication. If lookup is forbidden, incomplete, or cannot establish absence after an ambiguous create, remain unknown/blocked for operator recovery rather than blindly duplicating a reply.

The initial fixture uses one installation/thread and a conservative shared write budget. General rollout needs provider quota coordination across sessions or a documented deployment-level limiter; per-sidecar throttling alone is not a workspace quota solution. Start with at most one write per second to the fixture destination and honor method-specific throttling.

### 10.4 Interactive routing and missing context

Existing Slack click routes remain ingress. Keep prompt acknowledgements/deferral there. The renderer posts/updates the UI, while execution validates and settles the answer.

Audit every use of `pendingApprovalCards`, pending auth message IDs, current triggering user, and aliases. Move provider receipt bookkeeping into the renderer ledger; retain only facts needed for execution in execution state. A click must still locate the correct session/request/actor after a sidecar restart and after intervening turns. Never authorize a request based on renderer state alone.

If posting an anchor changes the conversation address, use an explicit supported association operation after the provider confirms the anchor. Pin target changes to revisions. Do not mutate a stale serialized copy of the root channel state or expose secrets just to reuse an old callback signature. Keep proactive sends gated until this works.

## 11. Step-by-step implementation work packages

Each package should be independently reviewable. Do not let a junior implementer improvise across unresolved boundaries.

### A. Baseline and contracts

- Record selected stack SHA and verify APIs.
- Complete the outbound-path/context audit (§3.3).
- Approve opt-in spelling and fixture scope.
- Identify workflow registry/build wiring and test tier owners.
- Prove exclusive hook ownership and the two-loop Workflow concurrency/checkpoint pattern in a minimal scenario using existing primitives. Cover crash/replay with a slow provider step. Do this before building the renderer.

**Done when:** no event/protocol names are guessed; every old outbound path has an owner or explicit release gate; a maintainer has approved the runtime proof. If a proof fails, report it and pause rather than redesigning ownership independently.

### B. Pure observation state

- Reuse the conversation reducer.
- Add source registry/cursor structures and deterministic application of indexed batches.
- Add JSON round-trip parity and cross-session ID-collision tests.
- Keep client optimism and provider state out.

**Done when:** independently expected conversation outcomes survive checkpoint/replay without duplicate text or reopened inputs.

### C. Bounded readers and discovery

- Implement local bounded read step first, remote direct-child access second.
- Preserve normalization and cleanup.
- Discover children from source events; limit concurrency and coverage explicitly.
- Expose unavailable/unsupported states without failing execution.

**Done when:** a parked source read ends at captured tail, restart resumes its cursor, and two sources with equal local IDs remain distinct.

### D. Pure Slack view and diff

- Implement reply/activity/error/status objects for the fixture.
- Build pure operation planner with stable keys and no omission-based deletion.
- Reuse Slack formatting/limits; no provider I/O here.

**Done when:** unchanged state plans no writes, a new reply plans one create, and progress changes plan updates to the same object.

### E. Effect steps and recovery

- Implement receipt/pending-operation journal and one-operation apply step.
- Add rate-limit scheduling, bounded metadata recovery, unknown/permanent failure states.
- Use the existing injectable Slack transport, not a new test-only production seam.

**Done when:** post/update behavior converges across retry and crash windows, or explicitly reports uncertainty without uncontrolled duplicates.

### F. Single sidecar orchestration

- Register a distinct workflow and one-time idempotent owner claim.
- Run independently progressing polling and delivery branches.
- Bound lifetime and checkpoint growth; expose diagnostic counters/state in existing Workflow/operator surfaces.
- Integrate fixture-only ownership switch; old handlers and old activity collector cannot write.

**Done when:** Slack output continues with the root parked, and a blocked Slack request does not stop the observation revision/cursor advancing.

### G. Follow-up project: interaction/file/routing completion

- Port questions/approvals/auth presentation into desired objects and existing validated ingress.
- Resolve trusted per-delivery context and private destinations.
- Implement long reply/files and proactive anchors.
- Reject incompatible authored event overrides and old activity configuration.

**Done when:** no supported outbound path in enabled sessions relies on old event-handler posts; sensitive routing and stale controls have independent tests.

### H. Evaluate and document

- Run the validation below.
- Measure polling overhead and parent responsiveness; record actual numbers, not assumptions.
- Document supported topology, mode lifetime, operator failure handling, and remaining gates.
- Decide whether to continue toward a public snapshot/feed or first simplify the spike.

**Done when:** maintainers can see exactly what improved, what remains unsupported, and whether one sidecar is viable.

## 12. Validation plan

Use the test-audit skill. Each test must own a credible regression; do not recreate the reducer in a mock or duplicate its entire existing suite. No new fixture trees under `packages/eve/test/fixtures/`; scenario apps use inline `ScenarioAppDescriptor` objects.

### Unit: pure contracts

- Indexed batch application: cursor/state alignment, duplicate prefix, scoped child identity, invalid record, ignored event.
- Shared reducer checkpoint continuation for streaming text, settled/open inputs, and repeated task calls.
- Desired view: distinct replies, safe child summary, private/public separation, long-message decision.
- Reconciler: unchanged content, changed mutable object, retained historical object, stale revision, priority, unknown create outcome.

### Integration: module behavior in memory

- Sidecar read adapter handles empty/capped pages, partial failure, normalization, cancellation, and independent remote credentials.
- Opt-in factory does not install managed posting handlers or the legacy activity collector; prove through observable output, not source greps.
- Click routes resolve the correct source/request/actor and reject stale/unauthorized responses; rendering is not authorization.
- Recording a provider result updates only the applied revision and leaves newer desired state pending.

### Scenario: real Workflow ownership and restart

One focused scenario app plus strict fake Slack transport should cover:

1. Root delegates, parks, child emits progress; sidecar changes Slack with no presentation payload in root inbox.
2. Provider operation blocks or returns 429; source cursors/projection continue advancing.
3. Crash/retry after source read and before checkpoint; no lost or double-applied prefix.
4. Crash after provider acceptance and before receipt checkpoint; metadata recovery finds the object or delivery becomes unknown, never uncontrolled duplicate posting.
5. Duplicate startup attempts; only one owner writes.
6. Sidecar restart while an approval is open, followed by reply and settlement; old controls disappear correctly.
7. Root terminal outcome, later child page, and delivery retry; final content is not abandoned at the first boundary.
8. Observation mode off: existing behavior is unchanged. Mode on: old handlers do not also post.

Use existing Workflow traces/state inspection to count root commands/steps. Do not add fake production counters solely for tests. Separate checks for slow reads and slow writes if necessary to prove scheduling rather than assuming `Promise.all` provides isolation.

### E2E and provider smoke

Add/update deterministic fixture evals under the appropriate channel/subagent fixture on the chosen base. E2E runs only in CI and must not require a real Slack workspace or external service startup. Use benign Alice/Bob scenarios. Optional real Slack smoke is a separate, explicitly authorized manual check with a designated test thread; do not post during implementation without permission.

### Commands for implementation

Run actual changed-file patterns with the correct tier configs:

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts <changed-unit-pattern>
pnpm --filter eve exec vitest run --config vitest.integration.config.ts <changed-integration-pattern>
pnpm build
pnpm --filter eve exec vitest run --config vitest.scenario.config.ts <observation-scenario-pattern>
pnpm fmt
pnpm lint
pnpm typecheck
pnpm guard:invariants
pnpm docs:check
```

If changing `#compiled/*`, rebuild with `pnpm --filter eve build:compiled` before tier tests. Do not execute placeholders literally or report these commands as already run. The research task has not implemented or tested this spike.

## 13. Measurements and go/no-go

Record off/on results using the same deterministic workload and machine/deployment:

- Parent latency from accepted user/control/child-result input to the next execution boundary.
- Parent workflow activation/step counts with and without presentation-only child traffic.
- Sidecar poll count, empty reads, bytes, Workflow history/checkpoint growth, and peak source concurrency.
- Source event to observed revision latency; observed revision to confirmed Slack output latency.
- Provider writes avoided by coalescing, retries, unknown outcomes, and recovery reads.
- Behavior for 1, 4, and 16 active direct children and multiple root sessions sharing a provider quota.

Do not promise zero total overhead: readers and execution share infrastructure. The hard structural gate is no parent presentation inbox/steps and no awaited provider I/O on the root event path. Choose a quantitative indirect-overhead budget with a maintainer after obtaining a baseline, rather than inventing a millisecond guarantee in this plan.

**Proceed** if one independent sidecar converges, reuses the same semantics as clients, materially removes duplicate rendering paths, and preserves parent responsiveness.

**Stop/redesign** if it requires an unbounded transcript checkpoint, cannot recover provider create ambiguity, leaks private interaction data, relies on unsupported Workflow concurrency, or silently loses mandatory delivery at expiry. A useful failed spike reports the precise boundary; it does not hide it behind retries or legacy fallback.

## 14. Documentation, release, and handoff

- Add an experimental guide only for supported behavior; list unsupported descendant topologies and lifetime limits clearly.
- Include a changeset for implementation changes to the published `eve` package. New opt-in behavior is normally a patch; any breaking existing API changes require a minor under repository policy.
- Keep the old default path until the experiment is reviewed; do not migrate application-specific integrations or enable production agents as part of the first spike.
- Commit/push only when authorized; commits must be signed and include DCO sign-off.
- Handoff should name the base SHA, implemented packages A–H, exact checks run, measured costs, known gaps, and opt-in instructions.

The intended first proof is concrete: **a parent delegates and stays parked; one polling sidecar observes root/child streams with the shared reducer, reconciles replies and progress into one Slack presentation, survives retry, and never asks the parent to do presentation work.**
