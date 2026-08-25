---
issue: https://github.com/vercel/eve/issues/1084
status: draft
last_updated: "2026-08-25"
---

# Background tool authoring API

## Summary

Replace public `TaskExec` with an eve-owned durable executor for static authored background tools.
The provider call returns a task receipt after durable parent admission. A separate task-keyed
workflow then invokes authored `execute`; its eventual return or throw settles the task.

The stable surface does not expose task inbox tokens, arbitrary executor bindings, session
snapshots, detached in-process callbacks, or framework subagent internals. Dynamic background tools
and external callback executors remain unsupported until their durable identity and protocol have
independent designs.

## Authoring API

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Build a report in the background.",
  execution: "background",
  inputSchema: z.object({ projectId: z.string() }),
  receipt: {
    schema: z.object({ projectId: z.string() }),
    create: ({ projectId }) => ({ projectId }),
  },
  resultSchema: z.object({ reportUrl: z.string().url() }),
  async execute({ projectId }, ctx) {
    await ctx.task.update("Collecting data.");
    return buildReport(projectId, {
      idempotencyKey: ctx.task.taskId,
      signal: ctx.abortSignal,
    });
  },
  toModelOutput: ({ reportUrl }) => ({ type: "json", value: { reportUrl } }),
});
```

The background overload has explicit phase types:

```ts
interface BackgroundToolContext extends ToolContext {
  readonly task: {
    readonly taskId: string;
    update(message: string): Promise<void>;
  };
}

type BackgroundInputSchema<TInput> = StandardSchemaV1<unknown, TInput> &
  StandardJSONSchemaV1<unknown, TInput>;

interface BackgroundReceiptDefinition<TInput, TReceipt extends JsonObject> {
  readonly schema: StandardSchemaV1<unknown, TReceipt> & StandardJSONSchemaV1<unknown, TReceipt>;
  create(input: TInput): TReceipt;
}
```

The background overload requires `inputSchema: BackgroundInputSchema<TInput>`. Validator-only,
emitter-only, and validation-free plain JSON Schema inputs remain valid for foreground tools but are
rejected for this durable executor contract.

`receipt.create` is synchronous and must be deterministic under replay: no I/O, process mutation,
unawaited work, time, randomness, or other side effects. This is an authored obligation that eve
cannot prove; eve can only validate the returned value. It runs after input validation but before any
task run starts. A throw, schema failure, non-JSON value, or authored `taskId`/`status` key fails the
tool call without admitting a task. eve freezes the validated receipt data and stamps
`{ taskId, status: "working" }`. Without `receipt`, the stamped fields are the whole receipt.

`resultSchema` has the same live-validator plus JSON-Schema intersection and is used only for
terminal `execute` output. Plain JSON Schema and Standard JSON Schema definitions without a runtime
validator are rejected for this field; eve does not claim guaranteed validation through its current
validation-free JSON-Schema fallback.
`toModelOutput` receives the validated terminal value. There is no receipt projection in the first
stable release: the model and Workflow program receive the stamped JSON receipt so `task_cancel`
always has a machine-readable `taskId`.

The AI SDK-facing tool output schema is the stamped receipt schema derived from `receipt.schema`,
not `resultSchema`. Generated Workflow signatures likewise describe a projected JSON receipt. The
terminal result schema is published separately as task metadata and never describes the original
provider tool result.

## Durable input

Admission persists the raw provider JSON plus the validated transformed output. A background input
schema whose output contains `Date`, class instances, binary objects, functions, or any other
non-`JsonValue` fails before receipt construction. The executor does not feed transformed output back
through the input validator. It verifies the pinned schema/implementation revision, then uses the
persisted transformed JSON value directly. Tests prove the admission validator produced it from the
persisted raw input; retries replay that committed result rather than assuming transforms are
idempotent.

`receipt.create` and `execute` therefore observe the same durable transformed input value. Raw
provider arguments remain in provider history and executor audit state, but execute never sees a
second transformation.

## Admission and readiness

The retryable parent turn step only stages admission and a pending provider result:

1. validate and normalize input;
2. derive the task ID from parent session, turn, and exact tool call ID;
3. synchronously construct and validate the stamped receipt;
4. start the task run, which claims its deterministic task inbox;
5. return staged task state, executor intent, and a versioned pending-receipt effect keyed by the
   original tool-call ID. The AI SDK call remains interrupted; the receipt is not yet provider-visible.

The turn workflow adopts staged parent state at its durable boundary. If the step rolls back, fails,
or is cancelled before adoption, its compensation path sends `reject-dispatch` to every staged task
run and closes their inboxes; no unindexed task remains `working`. After adoption, a separate dispatch
phase starts an executor candidate. The candidate publishes its address but cannot execute yet.

The task workflow is the single admission authority. It verifies the task is still nonterminal,
grants one numbered executor attempt, binds that candidate, and sends readiness. If cancellation won
before binding/readiness, it rejects the candidate and settles/abandons it without running authored
code. Startup failure terminalizes the indexed task and records a safe `BACKGROUND_TOOL_START_FAILED`
resolution on the pending-receipt effect. The parent workflow then resumes the interrupted original
tool call with that ordinary tool error under its original call ID; it never emits a working receipt.
Once readiness commits, the parent instead records and injects the receipt exactly once under the
same call ID. The code-mode adapter resolves the matching nested ledger promise through these same
success/error arms. Replaying either completed effect reads its recorded resolution and cannot emit a
second provider result or leave the call parked.

This explicit park/resume protocol avoids both failure modes: the model cannot see a receipt before
durable admission, and the admitting step never waits for a commit that depends on its own return.

## Generation pinning

Admission records an immutable runtime revision and deployment/artifact address. Production starts
route the executor to that pinned deployment, not `latest`; development records the immutable
snapshot source. The platform must retain the revision for at least the task lifetime. If the
current world cannot identify, route, or retain an immutable generation, background admission fails
before returning a receipt.

Static tool identity includes node, source, source hash, schemas, and execution contract. Executor
loading verifies that identity before running. Dynamic background definitions remain rejected,
because current callback registration is name-based/latest and cannot retain revision-keyed
closures safely.

## Executor workflow

The winning executor workflow owns:

- a cancellation hook and durable `AbortController`, following turn cancellation's ownership model;
- the pinned runtime/tool identity, JSON input, current task auth state, sandbox, and instrumentation;
- its accepted attempt number and replay-stable progress command IDs;
- terminal validation, model projection, and private settlement commands.

Executor claims are leased, numbered attempts owned by the task workflow. A candidate that claims
but fails before address publication/readiness loses its lease after a bounded durable deadline. The
task workflow can revoke it and grant the next attempt; every executor checks its attempt number and
lease immediately before authored `execute` and before each task command. A stale owner cannot run
concurrently with its replacement. Attempt takeover is observable and bounded; exhausting attempts
terminalizes the task rather than stranding dispatch.

Approval is evaluated before task admission in the parent tool call. Admission binds the executor to
the parent session's initiator principal and records the current principal for the attempt. An
authorization signal inside `execute` is not output or failure: the executor stores private
continuation state under its task/attempt capability, sends the existing task authorization event,
and parks. The parent-session authorization callback may resolve it only after normal responder and
principal checks; no task/executor token enters the public callback. After completion, the executor
refreshes credentials for that bound principal and attempt, verifies the parent/task is still live,
and resumes pinned execute. Parent finalization rejects later authorization completion. Authors must
authorize before external effects and use `ctx.task.taskId` for retry idempotency.

The generic Workflow tool adapter performs the same approval and admission path with the exact
QuickJS ledger call ID. It registers the background cohort before execution, waits for post-commit
readiness, and resolves the nested call with the projected JSON receipt. Terminal task output never
resumes the Workflow program.

## Progress

`ctx.task.update` sends bounded model-visible task content through the task workflow, which is the
only owner of progress epoch/index allocation. Each execute-step invocation derives a stable command
ID from task ID, accepted attempt, durable step identity, and update call ordinal. Retrying the same
update reuses that command ID. The task workflow maps it once to `(epoch, index, messageHash)`, returns
the prior allocation on identical replay, and rejects command-ID reuse with a different message. It
allocates a new epoch only when it grants a replacement attempt.

The same task-owned state enforces per-message bytes, update count, and aggregate progress bytes
across every epoch, so retries cannot reset limits. Exceeding a limit rejects the update with a named
error without failing an otherwise healthy task. Update content is labeled as untrusted task output
before entering model context.

## Terminal output and errors

The executor validates raw `execute` output with `resultSchema`, emits ordinary private
instrumentation, and runs `toModelOutput` (or the normal default projection). The raw terminal value
exists only inside that executor step and is discarded after projection; it is not stored in the
task view or emitted as a second `action.result` for the original provider call. The admission
`action.result` remains the receipt.

The validated `ToolModelOutput` projection is the only terminal payload persisted in the task run,
cached in the parent index, and delivered to parent model context. Projection/serialization failure
terminalizes the task with a safe framework error without persisting raw output. Authors needing a
full durable result must store it in their own system before returning a safe summary.

An unhandled throw becomes:

```ts
{ code: "BACKGROUND_TOOL_FAILED", errorId: string, message: "Background tool failed." }
```

The original throwable and stack are logged under the same `errorId`; arbitrary `Error.message`
text never enters model context. An eve-owned public error type may carry a separately validated,
size-bounded public message. Receipts, terminal projections, errors, and progress have independent
byte limits; oversize values fail rather than truncate JSON.

## Cancellation and closure

`task_cancel` first commits task status `cancelled`, then signals the executor's task-keyed cancel
hook. The executor control aborts `ctx.abortSignal`. After a bounded grace period, the controller
uses Workflow `cancelRun` if authored code has not unwound. Confirmed completion/cancellation sends
`settle-executor`; a bounded, observable inability to reach the run records private executor
`abandoned` lifecycle, which also permits the cancelled task inbox to close.

The task workflow, not authored code, owns terminal executor settlement. A late return, throw,
authorization callback, or update cannot replace `cancelled`. Parent finalization uses the same
controller and bounded abandonment path.

Cancellation is also durable intent for not-yet-bound executors. A candidate must read terminal task
state before claim, binding, readiness, and execute. If cancellation precedes hook publication, the
later candidate observes it and exits; cancellation never depends on a transient hook already
existing.

## Replay and external effects

Task IDs and private control capabilities are distinct. The task inbox capability is secret-derived,
scoped to the task and parent owner, and remains stable for the task lifetime so the parent task index
never loses cancellation/control authority. Executor claim/readiness, cancel-delivery, and
authorization-resume capabilities additionally scope to the numbered attempt and rotate on takeover.
None appear in receipts, task views, model context, public events/instrumentation, logs, or safe
errors. Replayed admission may start another workflow run, but only the task-workflow lease holder
passes readiness and enters authored `execute`; this is ownership claim idempotency, not an
assumption that `start()` deduplicates runs.

The execute step itself remains at-least-once across process failure and authorization resume.
External writes must use `ctx.task.taskId` as their upstream idempotency key. A bare provider call ID
is not globally safe across sessions.

## Framework-private delegated executors

Subagents keep a separate internal capability: eve starts local/remote child sessions, stores private
executor addresses, and maps child lifecycle onto task runs. That module may use inbox tokens,
bindings, session snapshots, and sibling batch metadata unavailable to authored tools. Framework
subagents use a private tool factory rather than the public background overload.

The public `eve/tools` surface removes `TaskExec`, `TaskBinding`, `TaskExecutorBinding`,
`TaskDelegated`, `TaskSendCommand`, `task.delegated`, `task.send`, and public batch/session/task-record
fields.

## Compatibility and release

This is a pre-1.0 minor release. The new tool capability epoch is 18. Tool epochs 14 and 16 are
dropped because their immutable fixtures use `task.delegated`/`task.send`; epoch 17 is dropped
because its reachable public contract exposes `TaskExec`. Previously supported foreground-only
epochs 1-13 remain after behavioral fixture validation; epoch 15 stays dropped. The drop reasons are
recorded in the compatibility table.

Dynamic background tools are rejected in this release, so `dynamicTool` remains at epoch 18 and its
durable metadata does not change. Because dynamic definitions materialize at event time, dynamic
result normalization rejects an entry carrying `execution: "background"` before advertisement or
admission, logs a named unsupported-definition diagnostic with resolver/event/entry identity, and
atomically omits that resolver's complete result under the existing resolver-failure policy. A later
proposal must add revision-keyed callback retention, execution metadata, cold replay, migration, and
a new dynamic-tool epoch.

`experimental.tasks` remains required until task-mode graduation. Stabilizing author execution does
not silently enable task controls, prompts, or reporting.

## Verification

Required coverage includes receipt/input validation and failure-before-admission; parent adoption
before readiness; original-call park/resume and exactly-one success/startup-error injection;
rollback/cancel
compensation before adoption; duplicate task/executor claims; lease expiry/takeover and exhausted
attempts; cancellation before hook publication/binding/readiness/execute; pinned generation loss;
executor startup failure;
authorization park/resume; approval before admission; progress replay epochs; terminal validation
and projection; safe error/size limits; cancellation before/during/after execute, ignored abort,
forced run cancellation and abandonment; parent finalization; Workflow cohort/receipt behavior;
dynamic event-time rejection diagnostics/omission; private capability non-disclosure and rotation;
private subagent executors; tool epoch 18 and dropped 14/16/17 fixtures; and
deterministic local/Postgres/Vercel scenarios.

## Scope boundaries

This proposal does not expose dynamic background tools, a public external callback endpoint,
arbitrary executor bindings, task polling/waiting, exactly-once external effects, or configurable
task retention. Those require separate protocols and threat models.
