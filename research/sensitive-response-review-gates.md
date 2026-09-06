---
issue: TBD
status: draft
last_updated: "2026-09-04"
---

# Sensitive response review gates

> **AI status:** Written entirely by AI; human review pending.

## Summary

Current eve can securely approve each sensitive tool call before it executes, or isolate sensitive
work in a subagent or workflow tool, but it cannot pause a root turn after synthesis and before both
canonical history commit and channel delivery. Authored hooks cannot provide that boundary: channel
handlers run first, the event is durably recorded next, and hooks are observe-only subscribers after
both. Tool results also enter the turn's durable working snapshot after each model step, before a
later model call synthesizes the final answer.

The immediate framework direction is a general serialized `restoreHistory` session control plus a
minimal `beforeResponseRelease` hook. The control restores an exact model-history prefix. The hook lets authored policy inspect terminal output while eve holds its
`message.completed` event and request the same restoration before release. This supports the narrow
use case without adding a framework notion of sensitivity or a lifecycle unit spanning several
turns.

This thin feature is logical restoration, not confidential execution. A stronger framework-level
**quarantined turn** remains the direction when unapproved content must also stay outside ordinary
events, hooks, memory, telemetry, and execution storage.

Until that framework feature exists, the best approximation is to put sensitive retrieval and
synthesis behind one declared subagent invoked by a waiting workflow tool, keep sensitive tools off
the root, and have the workflow obtain a private approval before directly delivering the exact
approved draft. Return only a non-sensitive receipt to the root. This gives one review prompt and
keeps sensitive content out of root history, but it needs a bespoke private review surface and still
persists sensitive data in the child/workflow or an external protected store. Existing Slack HITL is
posted to the session thread and is not itself a private review enclave.

A durable review cannot guarantee that sensitive content is never persisted anywhere: the model
needs tool results across steps, and the draft must survive a process restart while awaiting a
human. The achievable contract is that unapproved content is persisted only in an access-controlled,
retention-bounded quarantine, never in canonical session history, ordinary event streams, channel
messages, unprivileged hooks, or content-bearing telemetry.

## Implementation direction

Implementation exploration tested a per-turn checkpoint and a pre-commit `"commit" | "rollback"`
hook. That design is too tightly coupled to the current turn. Existing HITL parks and resumes across
turn boundaries, while the application may need to remove all model history from the original user
question through final synthesis.

The narrower plan separates history restoration from terminal release gating. It does not add a new
first-class lifecycle unit or make sensitivity a framework concept.

### Serialized session history restoration

Add a general session control alongside `clear` and `compact` that restores model-visible history to
an earlier boundary in the current serialized session history.

```ts
await session.restoreHistory({ to: questionIndex });
```

The control is serialized through the existing session inbox. It may retain only an exact prefix of
the observed history; authored code cannot replace or inject arbitrary messages. The runtime rejects an out-of-range index.
Like `clear` and `compact`, restoration affects future model-visible history. It does not retract
stream events, provider calls, tool side effects, memory writes, traces, sandbox writes, external
records, notifications, or channel messages already observed.

The initial implementation should keep this mechanism independent of task cancellation. An index
into model history does not identify every task or side effect created while the removed suffix was
produced. Adding that ownership requires a separate, explicit contract rather than inferring it from
a per-turn checkpoint.

### Minimal pre-release boundary

History restoration alone cannot prevent an already-completed answer from reaching Slack. Keep a
minimal `beforeResponseRelease` hook for policies that must inspect the terminal candidate while eve holds
its terminal `message.completed` event.

The hook does not return a framework-prescribed commit or rollback decision. It may request history
restoration through a settlement-scoped capability:

```ts
export default defineHook({
  beforeResponseRelease(candidate) {
    const questionIndex = findRelevantUserMessage(candidate.history.messages);
    const attempt = candidate.history.messages.slice(questionIndex);

    if (containsSensitiveData(attempt) && !containsRequiredApproval(attempt)) {
      candidate.history.restoreTo(questionIndex);
    }
  },
});
```

If no hook requests restoration, eve keeps the candidate history and releases the terminal event.
If a hook requests restoration, eve applies the validated prefix restoration and suppresses the
pending terminal event. Multiple hooks may request restoration; the earliest valid boundary wins.
Throwing fails settlement rather than releasing content.

The settlement capability and serialized session control share one internal history-restoration
operation, but their public timing remains explicit:

- `session.restoreHistory(...)` is a serialized control for an idle or concurrently addressed
  session. It changes future model context but cannot retract prior delivery.
- `candidate.history.restoreTo(...)` is available only while the terminal event is held. Restoration
  at this boundary also suppresses that pending event.

### Policy inputs and limits

The authored policy still needs trustworthy evidence. Raw model history may contain only a tool's
`toModelOutput` projection, so applications must preserve any sensitivity label needed by the hook.
Approval must be correlated with the candidate output or its digest; the mere presence of an earlier
approval is insufficient.

This design provides logical history restoration and terminal response suppression, not confidential
execution. Earlier events, hooks, memory, telemetry, execution storage, and external systems may
already have observed candidate content. The quarantined-turn design below remains necessary when
unapproved content must stay outside those internal consumers. Private Slack preview is orthogonal:
it controls who can see approval UI, while restoration controls future model context and the held
terminal response.

## Required security contract

The request combines four distinct guarantees that should not be conflated:

1. **Retrieval authorization:** the caller may access the resource returned by each tool. This stays
   in the tool and is keyed to the requested resource; HITL is not authorization.
2. **Information-flow tracking:** a trusted runtime decision marks the turn sensitive when any tool
   result is sensitive. A model statement or prompt instruction is not a security boundary.
3. **Private review:** only an authenticated, policy-authorized reviewer can see and decide on the
   candidate answer.
4. **Atomic release:** no unreviewed content reaches canonical history or an outward channel, and
   the bytes posted after approval are the bytes reviewed. A second model synthesis after approval
   breaks this guarantee.

“Private” must name an audience. For Slack, a thread button is not private from thread participants.
The likely reviewer is the authenticated triggering user, with an optional response policy for a
separate approver. The preview should be an ephemeral message, DM, or authenticated review page,
not the public thread.

## Current eve execution boundaries

The relevant current behavior is:

- Tool `approval` runs before `execute`. It can inspect input and session auth, but not the eventual
  output or its sensitivity. `always()` therefore implements call-level authorization, not answer
  review.
- A workflow tool can fetch data, call `ask`, suspend durably, and return only after approval.
  Several fetches can be grouped into one workflow and one `ask`.
- `ask` emits `input.requested` on the owning session. Slack's default handler posts the prompt and
  controls to the thread. The prompt and event are not an out-of-band private secret channel.
- Declared subagents have separate history, tools, connections, hooks, state, and sandbox. Parent
  hooks do not observe child events. Child HITL and authorization events are nevertheless proxied to
  the parent session so its channel can render them.
- Declared subagents are background tasks. The parent first receives a working receipt; completion
  later wakes it with the result. The parent may continue and emit messages while the child works.
- A child parks after answering and remains resumable. There is no authored “discard this child and
  erase its durable history” primitive. Task cancellation stops live work; it is not secure erase.
- A tool's `toModelOutput` can project a full result to a reduced model-visible value, but
  `action.result` still carries the full output. It is useful for handle-based designs, not a
  comprehensive confidentiality boundary.
- The harness appends tool-call response messages after every completed model step and uses that
  snapshot on the next model call. Tool gathering and answer synthesis are therefore not one
  uncommitted callback scope.
- The harness emits text deltas and `message.completed` while consuming a model response. Slack
  normally posts terminal text from `message.completed`, but the durable stream, instrumentation,
  and hooks can observe content earlier. Slack reasoning and action status handlers can also expose
  derived progress unless disabled or redacted.
- Channel event handlers run before the event is stamped and written. Their errors are swallowed.
  Authored hooks run only after the channel handler and durable stream write; return values are
  ignored, and throwing turns the run into a failure rather than rolling it back.
- Session history is append-only within a turn. Compaction is the intentional rewrite mechanism;
  public clear removes the whole model history. Selectively deleting sensitive tool results after
  they have been committed would also risk invalid provider history by separating tool calls from
  their required results.

## Information-flow timelines

Legend:

```text
[M]  main-agent model context/history       [S]  subagent model context/history
[Q]  private quarantined durable state      [C]  canonical eve durable history/stream
[R]  private reviewer surface               [P]  public/shared channel
!    potentially sensitive content crosses this boundary
---  no sensitive content crosses this boundary
```

These timelines distinguish **model exposure** from **user/channel exposure**. Any model that
synthesizes from sensitive values necessarily receives them in its inference context. The review
gate controls later persistence and release; it cannot make that inference disappear. Provider-side
logging and retention must therefore be configured independently.

### Current root tool loop without a release gate

Multiple tool calls may span several model steps. Each completed step becomes the durable prompt for
the next one, so sensitive results enter canonical history before final synthesis.

```text
time ───────────────────────────────────────────────────────────────────────────────▶

user request       public tool       sensitive tool       final synthesis       Slack
    |                   |                   |                    |                  |
    v                   v                   v                    v                  v
[M] request ───── [M] safe result ──! [M] sensitive result ──! [M] draft ───────! [P] draft
    |                   |                   |                    |
    v                   v                   v                    v
[C] request ───── [C] safe step ────! [C] sensitive step ───! [C] final answer

                              No review or rollback boundary
```

Content can reach the channel before an authored hook sees it:

```text
model text -> message.completed -> Slack channel handler posts ! -> durable event write -> hook
```

Text deltas, reasoning, tool events, instrumentation, and hooks may observe content even before the
terminal `message.completed` event, depending on their configuration.

### Option A1: approval before every sensitive retrieval

The sensitive result does not exist until approval, but several calls can produce several prompts.
Once approved, the result follows the ordinary root path and there is no answer-level review.

```text
time ───────────────────────────────────────────────────────────────────────────────▶

sensitive call  approval  fetch result     second call  approval  fetch result   synthesize  Slack
      |            |           |                |           |          |              |        |
      v            v           v                v           v          v              v        v
[M] call ─────── [R] gate ──! [M]/[C] result ─ [M] call ─ [R] gate ─! [M]/[C] result ─! draft ─! [P]
                 one prompt                                  another prompt
```

### Option A2: retrieve, classify, then approve inside workflow tools

Each workflow can withhold its result from the main model until approval. The value must still
survive the durable wait inside workflow state, and a normal `ask.prompt` that includes it is sent
through ordinary HITL events and the Slack thread.

```text
time ───────────────────────────────────────────────────────────────────────────────▶

main calls tool      workflow fetches       durable wait/review      return        synthesis  Slack
      |                       |                      |                    |              |        |
      v                       v                      v                    v              v        v
[M] call -----------! workflow private state ----! [R]* ------------! [M]/[C] result ─! draft ─! [P]

* With current standard Slack HITL, this is normally a thread post, not a private reviewer surface.
```

Wrapping all retrieval and synthesis in one workflow reduces the interaction to one review, but
then the workflow—not the open-ended root loop—must own the complete answer.

### Option B: confidential declared subagent

The sensitive values and draft remain outside main-agent history while the child works. Returning
the candidate exposes it to the parent and commits it as a task/tool result. If the parent rewrites
it, the delivered answer is no longer the reviewed answer.

```text
time ───────────────────────────────────────────────────────────────────────────────▶

parent delegates       child fetches        child synthesizes      review       child returns
      |                      |                       |                 |                |
      v                      v                       v                 v                v
[M] task receipt ---  --- [S] request ─────! [S] results/draft ──! [R]* ───────────! [M]/[C] result
                                                                                         |
                                                        parent model rewrites ! ----------+
                                                                                         |
                                                                                         v
                                                                                      ! [P] Slack

* Child HITL is proxied to the parent channel. Putting the draft in the request leaks it to that
  channel unless a new private renderer or external review surface resolves an opaque candidate id.
```

A safer variant never returns the candidate to the parent:

```text
[S] sensitive work -> [R] approve exact draft -> direct idempotent Slack post ! [P]
                                      |
                                      +-> main receives only { delivered: true } --- [M]/[C]
```

That variant works as an interim application architecture but bypasses normal parent synthesis and
requires custom secure review and delivery code.

### Option C implemented as a current authored hook

This gate is too late. Earlier tool steps and the draft are already canonical, and the Slack handler
runs before the hook on `message.completed`.

```text
time ───────────────────────────────────────────────────────────────────────────────▶

tool result committed       draft completed       Slack handler       authored hook       delete?
         |                         |                    |                    |               |
         v                         v                    v                    v               v
! [M]/[C] sensitive result ──! [M]/[C] draft ─────! [P] posted ──────── [R] too late ── X unsafe

X Selective deletion can orphan tool calls, cannot retract Slack or event consumers, and does not
  erase traces, hooks, provider logs, sandboxes, or external systems.
```

### Recommended framework lifecycle: quarantined turn

The main agent may still perform the work, but the active branch is private and non-canonical until
review. Sensitivity is accumulated by trusted runtime metadata. Ordinary hooks, memory, streams,
and channel handlers receive only redacted lifecycle metadata before release.

```text
time ───────────────────────────────────────────────────────────────────────────────▶

canonical checkpoint   mixed tool loop in candidate      terminal draft       private review
        |                       |          |                    |                    |
        v                       v          v                    v                    v
[C] request ────────> [Q]/[M] safe ───! [Q]/[M] sensitive ─! [Q]/[M] draft ────! [R] candidate
        |                       |          |                    |                    |
        |                       +----------+--------------------+                    |
        |                 [C]/ordinary stream: redacted metadata only                |
        |                                                                            |
        |                      approve exact bytes / approved edit                    | reject
        |                                  |                                         |
        |                                  v                                         v
        +──────────────────────! [C] minimized approved answer               destroy [Q]
                                           |                                [C] safe status only
                                           v
                                  idempotent release outbox
                                           |
                                           v
                                        ! [P] Slack
```

Crash-safe approval requires `[Q]` to be persisted somewhere protected. The guarantee is therefore
not “sensitive bytes are never persisted”; it is “unapproved bytes exist only in the quarantined
security domain and never enter canonical history or outward delivery.” Approval should normally
promote only the exact reviewed answer and provenance/audit metadata, not the raw tool branch.

## Option analysis

### Option A: approve sensitive tool results individually

There are two variants:

- `approval: always()` asks before retrieval. This is the strongest existing boundary when data
  must not even be fetched without consent, but it cannot classify the returned value and may
  produce many prompts.
- A waiting workflow tool can retrieve first, inspect the result, then call `ask` before returning
  it to the model. This can make one tool call self-contained and durable, but each independently
  called wrapper still asks separately. The retrieved value is already in the workflow's durable
  execution record, and showing it in `ask.prompt` places it in normal HITL delivery.

A handle-based variation returns opaque references from retrieval tools and exposes one final
“release these references” workflow tool. It batches consent and keeps raw values out of root model
history until release. It still cannot let the root model synthesize a draft before release; if a
human must review the answer rather than the source data, synthesis has to move behind the handle.

**Use when:** approval is about access to each source or operation, or the sensitive data can be
summarized deterministically inside one workflow.

**Limitation:** it does not naturally review one answer assembled by an open-ended root tool loop.

### Option B: isolate sensitive work in a subagent

This is feasible if the boundary is structural:

- Remove sensitive tools from the root and expose them only to a declared subagent.
- Have the child perform every operation that needs the sensitive values and produce a complete
  candidate answer. Non-sensitive context needed by the child must be included in its invocation or
  fetched again; the child never sees parent history automatically.
- Do not return the candidate until an authorized review succeeds. On rejection, return only a
  non-sensitive status.

Important limitations:

1. A normal subagent call is a background task. The parent can continue, post an interim answer, or
   mishandle a later result unless its tools and instructions enforce the protocol. A waiting
   workflow tool that calls the child provides a more reliable orchestration boundary.
2. The built-in root-copy `agent` shares root tools and sandbox. A declared specialist is the
   narrower isolation boundary for this use case.
3. Child HITL is proxied to the parent's channel. Embedding the sensitive draft in a standard
   question therefore puts it in the parent `input.requested` event and default Slack thread post.
4. The parent sees any returned candidate as a tool/task result before its next model call. If the
   parent model is expected to render or rewrite it, the reviewed bytes are no longer the delivered
   bytes.
5. Denial or task cancellation does not erase the child session. Parent-session finalization cleans
   up live child ownership, but eve does not promise physical deletion of child history, workflow
   logs, sandbox data, traces, or external tool records.
6. Declared subagents have isolated authored slots. Shared tools, connections, skills, and sandbox
   policy must be deliberately mounted or authored in the child.
7. Sensitive work is invisible to parent hooks but not automatically invisible to child hooks,
   child streams, logs, instrumentation, provider retention, or the shared sandbox of a root copy.

**Use when:** an application can accept a protected child session as the sensitive persistence
boundary and can provide its own private review UI.

**Limitation:** it is isolation, not transactional commit or secure erase.

### Option C: a hook after tools and before Slack synthesis

This does not fit the current hook model and has two timing problems.

First, “after all tool calls” is not a stable model-loop boundary. A model may interleave prose and
tool calls, make more calls after seeing results, or finish directly. A pre-synthesis gate would
review permission to use data, not the actual answer. To vet the answer, the gate must be after
synthesis and before release.

Second, by either point the current pipeline has crossed boundaries the proposal wants to guard:

- prior step tool results are already in the durable working history used for synthesis;
- text may already have produced content events and telemetry;
- on `message.completed`, Slack's channel handler runs before authored hooks;
- hooks cannot replace, delay, or acknowledge events, and a throw cannot undo side effects or the
  stream write.

Overriding Slack's `message.completed` handler can suppress the final post, but it still leaves the
answer in model history and ordinary events. It also needs custom handling for deltas, reasoning,
actions, failures, retries, and eventual authenticated release. Wiping selected calls afterward is
both too late and incompatible with eve's append-only/provider-valid history assumptions.

**Use when:** the requirement is only “do not post the final Slack message automatically,” and
persisted history/events are allowed.

**Limitation:** it cannot provide the requested confidentiality or rollback semantics.

## Other viable application-level designs

### One confidential workflow with direct release

The strongest design available without changing eve is:

```text
root model
  -> waiting workflow tool (receives only non-sensitive request/context)
      -> declared confidential subagent fetches + synthesizes candidate
      -> protected review store / private Slack or web UI
      -> authorized approve, reject, or edit
      -> workflow posts the exact approved text idempotently
  <- { delivered: true } or { rejected: true }
```

The workflow should return only a non-sensitive receipt. The root should not receive or re-render the
candidate. Sensitive tools enforce resource authorization and exist only in the child. The direct
post needs an idempotency key derived from session, turn, and review request so workflow replay
cannot duplicate release.

This design preserves the root context but accepts sensitive persistence in the child, workflow,
model provider, and review store. A bespoke review callback must authenticate the responder, bind
the decision to the candidate hash and intended Slack destination, expire it, and reject replay.
Use an authenticated web page or DM when Slack ephemeral interactive support is insufficient; do
not put the draft in a normal `ask.prompt`.

### Separate private session or deployment

Route the request to a private eve session or separate deployment whose channel, hooks, storage,
telemetry, model retention, and credentials are configured for sensitive data. After review, send
only the approved text to the public destination. This is operationally heavier but gives a clearer
security perimeter than relying on prompt discipline inside one root session.

## Proposed framework direction: quarantined turns

A first-class feature should make review a transaction over a candidate turn, not a callback over
already-public events.

```text
canonical session checkpoint
        |
        v
private candidate turn -- tool calls/results --> terminal draft
        |                                      |
        |                              sensitivity = join(labels)
        |                                      |
        +---------------------- review requested privately
                                               |
                         +---------------------+--------------------+
                         |                                          |
                    approve/edit                                  reject
                         |                                          |
        commit approved projection + post exact bytes       destroy candidate;
        atomically (or outbox-idempotently)                  commit safe status only
```

### Authoring contract

The runtime needs a trusted classifier rather than a convention the model interprets. A compact
surface could let tool definitions project provenance and sensitivity from their full result, while
a channel or agent review policy decides which labels require review. Classification is monotonic
for the candidate turn: once sensitive, later non-sensitive calls cannot clear it.

The review policy should define:

- whether a candidate requires review from its accumulated labels and provenance;
- who may view and answer it, evaluated again at response time;
- which private renderer or review destination receives it;
- retention and denial behavior;
- whether approval can be binary or may replace the draft with reviewed text.

The model must not be able to set or downgrade these fields. Tool-level resource authorization
remains mandatory and separate.

### Commit semantics

- The canonical session commits the accepted user input, but not candidate assistant/tool messages
  while the turn runs.
- Candidate snapshots are durable, encrypted or equivalently protected, access controlled to the
  review policy, and retention bounded. They are not served by the ordinary session stream.
- Contentful `action.result`, reasoning, text delta, and completion events stay in a privileged
  candidate stream. Ordinary channel handlers, hooks, memory, and telemetry receive either metadata
  or a redacted projection until approval.
- At terminal synthesis, eve parks on a review request containing an opaque candidate id. The
  private renderer resolves the candidate under authorization rather than copying the draft into a
  public event payload.
- Approval commits a minimized canonical projection. Prefer the final approved answer plus
  provenance/audit metadata, omitting the hidden tool-call branch entirely; this avoids retaining
  raw source data and avoids invalid call/result pairs. Applications that truly need raw approved
  history may opt into promoting the complete branch.
- Delivery uses the reviewed text directly, with no second model call. Commit and channel send use
  an outbox/idempotency record so either can retry without duplicate or mismatched release.
- Rejection, expiry, cancellation, or reset destroys the candidate according to its retention
  policy and appends at most a generic non-sensitive outcome to canonical history.
- A candidate hash binds the decision to the draft, provenance set, destination, and policy
  version. Any change creates a new review request.

### Why this belongs below hooks

The harness owns model steps and canonical history; the execution layer owns durable snapshots and
turn parking; the channel adapter owns outward side effects. Only a boundary spanning those three
can ensure that a candidate is durable enough to resume while remaining absent from ordinary
history and delivery. General stream hooks should remain observation-oriented.

## Recommendation

1. **Ship serialized history restoration as the framework primitive.** Add
   `session.restoreHistory({ to })` alongside `clear` and `compact`. Accept only an exact prefix of
   the current history and reject an out-of-range index.
2. **Add the minimal pre-release capability needed by this use case.** Run
   `beforeResponseRelease` after terminal synthesis while `message.completed` is held. Let the hook
   call `candidate.history.restoreTo(index)`; restoration suppresses the pending response, while no
   call releases it normally.
3. **Leave policy and coarse rollback scope to the application.** The hook decides where the
   relevant request begins, how sensitivity is represented, and whether approval matches the
   candidate. Restoring an earlier prefix may discard unrelated intervening input.
4. **Do not infer task or side-effect ownership from history.** Initial restoration changes future
   model context only. It does not cancel work or retract events, memory writes, tool effects,
   traces, or messages already released.
5. **Keep quarantined turns as a stronger follow-on.** Add private candidate storage and event
   projection only for applications that must prevent unapproved content from reaching internal
   consumers, rather than making that larger lifecycle part of the narrow restoration feature.
6. **Use tool approval and subagent isolation where their existing boundaries fit.** Retrieval
   authorization remains separate from response review, and a confidential subagent remains an
   application architecture rather than the history-restoration abstraction.

## Validation requirements for a framework implementation

- Unit: sensitivity joins cannot downgrade; candidate hashes bind content, provenance, destination,
  and policy; response authorization fails closed; commit projection never leaves orphaned tool
  calls.
- Integration: several mixed-sensitivity calls produce one review; no ordinary hook, memory writer,
  channel handler, or content telemetry sees the candidate before approval; rejection and expiry
  leave canonical history free of candidate content; edited approval posts and persists identical
  bytes.
- Scenario: crash/redeploy at every tool, synthesis, review, commit, and delivery boundary resumes
  without losing the candidate, leaking it, or posting twice; cancellation/reset clean up the
  candidate; concurrent and replayed decisions settle once.
- E2E: a Slack fixture proves the preview is visible only to the authorized reviewer, an
  unauthorized interaction cannot approve, denial posts nothing sensitive, and approval produces
  exactly one reviewed message.

## Sources inspected

- `docs/tools/human-in-the-loop.md`
- `docs/tools/workflows.mdx`
- `docs/subagents/index.mdx`
- `docs/guides/hooks.md`
- `docs/channels/slack.mdx`
- `packages/eve/src/harness/tool-loop.ts`
- `packages/eve/src/harness/emission.ts`
- `packages/eve/src/harness/step-hooks.ts`
- `packages/eve/src/execution/workflow-steps.ts`
- `packages/eve/src/execution/turn-workflow.ts`
- `packages/eve/src/execution/durable-session-store.ts`
- `packages/eve/src/public/channels/slack/defaults.ts`
- `packages/eve/src/channel/adapter.ts`
- `packages/eve/src/context/hook-lifecycle.ts`
