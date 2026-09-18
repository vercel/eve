---
issue: https://github.com/vercel/eve/issues/1084
status: draft
last_updated: "2026-09-18"
---

# Background tasks: one workflow invocation runtime

**Prototype result: background work is a session-owned workflow invocation.** Waiting and
background tools now enter through one durable workflow kind, use one session invocation registry,
and share body execution, report drainage, and cancellation cleanup. The parent session retains
task outcomes, pending input routes, child ownership, and accounting. The background owner handles
admission and routes child messages through the existing session inbox.

This prototype is based on `32aca9b1485ce8fce0eb9c636d741456c1779f25`. The linked, closed issue
is provenance only. The branch is an investigation, not a production-ready migration.

## Approved decisions

The prototype implements three approved scope decisions:

1. Authored background work uses `defineWorkflowTool({ execution: "background" })`.
   `defineTool` and dynamic tools no longer accept background execution.
2. The authored `TaskExec` third argument, `TaskMessage`, `task.postMessage`, and deprecated task
   fields are removed. Workflow yields remain stream-only progress; `ctx.ask`, authorization, and
   framework-owned workflow requests remain.
3. Completed, failed, and cancelled outcomes wait for their existing session cohort and become one
   automatic report, including all-failed and all-cancelled cohorts. Lifecycle state still updates
   when each task settles. User input, human-input requests, and authorization do not wait for the
   cohort.

## Resulting execution model

`runWorkflowToolInvocation` is the sole workflow-body execution owner. It starts
`executeWorkflowBody`, owns the internal workflow inbox, drains every persisted report, and emits
the existing `WorkflowToolRunMessage` outcome only after those reports are consumed.
[Shared invocation][prototype-invocation]

`workflowToolRunWorkflow` is the only durable entry for both modes. One invocation loop reads
commands, workflow requests and reports, and body completion. It starts background work only after
`ready`, drains reports before settlement, and bounds cancellation cleanup. Blocking-owner handlers
deliver messages to the waiting turn; background-owner handlers route child messages to the session. The parent records task outcomes
and pending input routes. Admitted background work remains session-bound and survives the initiating turn. [Foreground adapter][prototype-blocking],
[background adapter][prototype-background]

| Concern                             | Before                                               | Prototype                                           |
| ----------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Workflow-body execution owners      | 2 direct callers of `executeWorkflowBody`            | 1 shared invocation loop                            |
| Background executor implementations | Workflow body or inline `defineTool` body            | Workflow body only                                  |
| Durable workflow kinds              | Foreground workflow-tool run and background task run | One workflow-tool run entry                         |
| Persistent records                  | Separate workflow-tool-run and task registries       | One invocation registry, with task payloads         |
| Authored background protocols       | Return/yield plus `TaskExec`/`TaskMessage`           | Return/yield plus workflow context                  |
| Terminal report classifier          | Successful `:ready:completed` delivery ID suffix     | Stable terminal delivery ID, retained after routing |

A task is the public handle for an admitted session-owned invocation. Both lifetimes now live in
`eve.runtime.workflowInvocations`; task lookup and waiting-run lookup are filtered views of that
registry. Cleanup selects the originating turn and `lifetime: "turn"`, so it cannot discard
session-owned work. [Registry][prototype-registry]

## Shared state and retention

Store invocation identity and ownership once; keep task-specific behavior in a typed `task` payload.
The identity is `(origin.turnId, callId)` within the owning session. `taskId` remains the public task
handle. No additional invocation ID or generic extension system is introduced.

```ts
type Invocation = {
  callId: string;
  toolName: string;
  resultKind: "tool" | "subagent";
  origin: { turnId: string; stepIndex: number };
  address: { runId: string; hookToken: string };
} & (
  | { lifetime: "turn" }
  | {
      lifetime: "session";
      task: {
        taskId: string;
        metadata: TaskMetadata;
        dispatchContext: TaskAgentDispatchContext;
        activityWorkIdentity?: ActivityWorkIdentityV1;
        cohortId?: string;
        terminalView?: TaskView;
      };
    }
);
```

The code names are `WorkflowInvocation` and `WorkflowTaskPayload`. `TaskAgentDispatchContext`
captures the creator's authentication and dynamic subagent selections; it must not be replaced
with the authentication of a later input delivery. `TaskMetadata` describes the public task,
`ActivityWorkIdentityV1` links its activity stream, and `TaskView` is its public status/output view.
`cohortId` groups overlapping work for one combined report.

| State                                             | Owner and lifetime                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Common identity, origin, run address              | Session registry; waiting entries are removed when their call settles or their turn is cancelled         |
| Task metadata, creator context, cohort membership | Typed task payload; retained for the session lifetime                                                    |
| Pending questions                                 | Parent session proxy-input state                                                                         |
| Final task status and output                      | Parent-owned `task.terminalView`; retained for the session lifetime, including after the combined report |
| Pending deliveries and report deduplication       | Existing session input queue                                                                             |

Registration precedes the `ready` admission command. A waiting outcome is matched against its
originating turn, call ID, and run ID. Authorization can end the visible turn while its workflow
call remains pending; cancellation uses the pending coordination batch's originating turn in that
case. Results without an origin can bind only to an unambiguous recorded call. Replaying
registration preserves original creator context,
cohort membership, and any recorded terminal outcome. Reusing a task ID for another turn is rejected.

**Retention decision:** completed, failed, and cancelled task payloads stay until the session ends.
Report delivery does not prune them. This avoids a second cleanup protocol for now; retained state
therefore grows with task count and final output size. Live progress is not copied into this registry.

## What was eliminated

The prototype deletes these responsibilities rather than renaming them:

- Parent-step execution of ordinary background tool bodies, async-iterable drainage, authorization
  return handling, and final task-command delivery.
- Lifecycle-only task runs with no workflow body and the optional no-body branch in
  the background workflow input.
- Two `TaskExec` constructors, `TaskMessage` detection, message buffering, and the dedicated
  task-message parent wake step.
- Background dynamic-tool persistence and replay.
- Success-only cohort classification; all three terminal delivery suffixes now share the barrier.
- `TaskExecutorBinding`, the `bind` command, fixed executor tags, and the separate executor-run
  cancellation lookup.
- The `taskRunWorkflow` durable entry and its stable workflow registration.
- Workflow-to-task outcome, progress, and question wrappers. The background owner consumes
  workflow messages directly; only session delivery and public view projection adapt their shape.
- Pre-admission progress buffering: the workflow body cannot emit before `ready` starts it.
- The separate `eve.tasks` and `eve.runtime.workflowToolRuns` stores, their independent write
  paths, and task-specific copies of creation provenance and run address.

These responsibilities were retained or relocated:

- Body start, report drainage, cancellation cleanup, and final outcome construction live in the shared invocation loop.
- Admission, compensation, child reservation/claiming, steering, task cancellation, and session
  indexing remain in the task owner.
- Waiting-run and task lookup remain filtered projections of the shared invocation registry.
  The lifetime discriminator controls cleanup.
- The session input queue still buffers active-turn deliveries and performs cohort release.

## Size comparison

The reduction comes from deleting ordinary background executors, the authored task-message
protocol, executor bindings, duplicate message conversions, and their associated tests. Shared
ordering and cancellation tests exercise the real invocation and channel readers for both modes.

Measure the current patch with `git diff --numstat 32aca9b1485ce8fce0eb9c636d741456c1779f25`.
For production source, include `packages/eve/src/**` and exclude `*.test.ts` and
`src/internal/testing/**`. Report documentation, generated extension reports, test support,
and E2E fixtures separately. The PR description records the current diff totals.

## Observable semantics

Background authoring has one supported shape:

```ts
import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Review a change in the background.",
  execution: "background",
  inputSchema: z.object({ request: z.string() }),
  async *execute({ request }, ctx) {
    "use workflow";
    yield { phase: "reviewing" };
    return await ctx.agent("reviewer", { message: request });
  },
});
```

The original call receives `{ status: "working", taskId }` after admission. Progress yields update
the stream without starting a parent turn. `return` completes the task, an escaping error fails it,
and task cancellation remains final against a late successful invocation outcome.

A **cohort** is overlapping background work owned by one session. Existing membership is
preserved across overlapping turns. The automatic report becomes eligible only when every member
is terminal, and it contains success, failure, and cancellation payloads. A user message remains a
normal turn, and workflow input/authorization requests remain serviceable while a cohort is open.
Explicit cancellation checks the parent's recorded outcome before cancelling owned work. It records
cancellation when the control step returns and queues a settlement notification with the existing
delivery ID. Late child outcomes cannot replace that parent decision. Steering cancellation continues to mark
superseded task deliveries for suppression.

## Compatibility and migration

This is a breaking authoring change, so the prototype includes a minor changeset and updated public
docs. Extension capability generation records `tool` epoch 45 and `dynamicTool` epoch 42. Channel epoch 24 removes executor bindings from task views and drops epoch 23. The authoring change also
drops retained epochs that explicitly exercised the removed surfaces: tool epoch 28, dynamic-tool
epochs 28–30, and the previous current epochs 44 and 41.

Migrate an ordinary background definition by replacing `defineTool` with `defineWorkflowTool`,
adding `"use workflow"`, moving nondeterministic side effects into `"use step"` helpers, removing
the third executor argument, and replacing parent messages with progress or the final return value.
A dependency on an intermediate result belongs inside the owning workflow through `ctx.agent`,
`ctx.ask`, or another durable operation.

Existing sessions containing either old registry key are rejected by the new runtime. Conversation
import can stop discoverable old runs and retain conversation history, but does not migrate pending
work. Completed task payloads also require the new format before deployment handoff.

The cross-deployment checkpoint version is now **5**. Version 4 readers also enforce exact
version equality, so both old-to-new and new-to-old handoffs reject the incompatible checkpoint
before hydrating nested state or claiming session hooks. The original owner recovers its hooks
and processes the triggering message. This version boundary is necessary even for idle sessions:
an older reader could otherwise overlook the new registry key and lose retained task outputs.

Within version 5, unknown fields on the registry, invocation, origin, address, task payload, and
terminal output survive parsing, replayed registration, and terminal-cache updates. Authentication
and dispatch-context schemas remain strict; incompatible changes there require another checkpoint
version bump. Session turns execute on their owning deployment. Legacy import returns its prepared
conversation snapshot to the parked old driver, rather than exporting the new owner's registry.

These checks protect the handoff boundary; they do not migrate in-flight workflows. A rollout must
keep the original deployments available for retained sessions and old task runs, or drain them first.

## Demonstrated behavior

| Requirement                                                   | Evidence                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Waiting workflow completion, failure, and progress            | Workflow integration suite                                        |
| Background receipt before later completion                    | Workflow integration suite exercises both root and child owners   |
| Commit before body start                                      | Task-owner unit test starts the workflow body only after `ready`  |
| Report before outcome                                         | Shared invocation unit test and task-owner report/outcome test    |
| Explicit cancellation wins over late completion               | Background-owner tests and invocation-loop tests for both modes   |
| Workflow human input and authorization routing                | Workflow integration suite and task-owner authorization tests     |
| Mixed success/failure and success/cancellation report         | Session next-input unit tests                                     |
| All-failed and all-cancelled report                           | Session next-input unit tests                                     |
| Active parent does not steer on terminal failure/cancellation | Session input queue and active-turn unit tests                    |
| Duplicate terminal delivery                                   | Existing session next-input deduplication unit test               |
| Cross-turn cohort membership                                  | Existing session next-input cross-turn unit test                  |
| Forced-stop cancellation notification                         | Cancellation integration test                                     |
| Mixed invocation lifetimes and retained terminal payloads     | Shared registry unit test and turn-cancellation integration tests |
| Completion after authorization ends the visible turn          | Workflow authorization integration tests                          |
| Extension migration boundary                                  | Generated capability reports and invariant guard                  |

Checks run before the checkpoint-version follow-up:

- Full unit tier: **799 files passed; 8,676 tests passed; 1 skipped**.
- Workflow/session integration slices: **7 files, 107 tests passed**, including authorization, handoff,
  telemetry, forced-stop cancellation, and retention during active or paused turn cancellation.
- TypeScript `--noEmit`, fresh production TypeScript/Rolldown build, focused lint, formatting,
  `git diff --check`, extension-contract generation, and `guard:invariants`: passed.
- Documentation frontmatter/navigation, import snippets, and MDX compilation: passed for all 89
  published pages.

The checkpoint-version follow-up passed 101 focused unit tests and all 35 session-entry and
legacy-import integration tests, plus typechecking and a fresh production build. The integration
suite initially failed a compatible legacy handoff while a build ran concurrently; the complete
rerun and an isolated repeat of that handoff passed. Build interference is unconfirmed. The tests verify version rejection before nested
state reads, recovery without duplicate input, and preservation of additive invocation fields.

The normal package-manager wrapper remains unavailable in this checkout because the private
registry requires `SOCKET_PASSWORD_B64`. Dependencies were installed from the local store with a
frozen lockfile, and the underlying checks were invoked directly. No credential value was read or
printed. Local E2E was not run because the repository marks it CI-only.

## Correctness and entropy review

Admission starts an invocation; only its outcome settles running work. A duplicate `ready` after
cancellation previously set the settled flag and exited before cleanup messages were consumed.
That defect was carried through from the old task owner. Admission is now accepted once; rejection
before admission returns without starting the body. The regression test first failed after consuming
only three of six messages, then passed with cleanup acknowledged before terminal delivery.

The review also removed seven registry/type aliases and the task-index facade. Callers now use the
workflow invocation registry directly. Mutations reuse their parsed registry rather than reading it
again during the write, and replay registration merges common fields once. Persisted formats and
task-payload retention are unchanged by these corrections.

This pass ran the full unit suite (799 files, 8,678 passed, one skipped), then 51 focused tests
after the final registry and admission edits. All 64 integration tests across workflow execution,
background dispatch, cancellation, and approval passed on rerun. The progress-after-answer test
failed once before passing in isolation and in the full rerun; the cause remains unconfirmed, and
its assertion now includes captured events for diagnosis. Typechecking, production build, focused
lint, formatting, and invariant guards passed.

## Ownership and cancellation consolidation

Ownership reads no longer decode every retained result, and both invocation lifetimes share
cancellation escalation. The persisted registry remains version 1 and checkpoints remain version 5.

- Removed the unused coordination `pendingTasks` acknowledgement list. Real background admission
  still persists ownership before sending `ready`.
- `settleWorkflowToolRunCancellation` owns polling and forced stop for both lifetimes. Body cleanup
  retains its 30-second limit; callers allow 35 seconds for cleanup and outcome publication. This
  replaces the task-specific one-second cutoff. The parent records cancellation after the control step finishes.
- Both child-owner paths use the same cancellation function and attempt every claimed child.
  Turn cancellation starts child cancellation alongside workflow cancellation. Background child
  failures remain retryable; all child requests settle before the helper returns or throws.
- Registry ownership and routing reads validate addresses, identity, and ownership metadata.
  `readWorkflowTaskView` validates the selected retained result and its task identity when consumed.
  A malformed old result cannot block cancelling an unrelated live invocation or removing a waiting
  invocation. Handoff still validates every retained result, even when other work is pending.

Cohort membership, delivery eligibility, creator context, and session-lifetime retention are unchanged.
No corruption recovery or quarantine mechanism was added.

Validation: all 800 unit files passed (8,692 tests, one skipped), and 73 integration tests passed
across workflow execution, task dispatch, turn cancellation, forced-stop notification, and handoff.
After final helper changes, the 29 workflow/cancellation integration tests and five child-cancellation
unit tests passed again. Typechecking, production build, lint, formatting, invariant guards, and all
89 published-doc checks passed. The first unit run exposed a missing active-turn marker in the new
cancellation fixture; correcting the fixture made it exercise the intended path.

## Remaining proof gaps and migration risks

The prototype does not yet demonstrate these full boundaries:

- A live upgrade and rollback between actual released deployments. Version rejection and owner
  recovery are tested locally; the old reader's version check was inspected in the base revision.

- An explicit initiating-turn cancellation racing after task admission while the background body
  remains blocked. Ownership is unchanged and existing retention code covers this path, but the
  exact combined prototype path lacks a dedicated test.
- One end-to-end model-call assertion that active-parent buffered terminal outcomes later become a
  single report. The tests separately prove active buffering and parked cohort release.
- Parent-session finalization cancelling a currently blocked invocation through the new reader.
- Reusable-child steering with a late superseded success through the complete combined path.
- Replay at the exact parent commit/`ready` boundary and a crash during final cohort release.

Removing the old `taskRunWorkflow` registration changes replay compatibility for in-flight runs
created by older deployments, including workflow-backed tasks. A production rollout needs deployment
pinning or a drain/migration plan; the prototype does not provide a legacy workflow fallback.

Delaying automatic failure output behind a slow sibling is an intentional behavior change. Task
state and activity still show failure promptly, but the model does not receive the failure as
conversation input until the cohort closes. Long-lived overlapping cohorts can therefore delay the
automatic report. No new timeout or grouping option was added.

The framework `agent` tool remains an internal exception to authored compilation: its definition is
runtime-rebound to the shared subagent workflow. The compiler exemption is limited to the existing
`self-agent` handling marker; authored background tools without a workflow ID fail with a migration
error.

## Parent-owned task state

The parent session owns durable task outcomes and pending input routes. Children send outcomes,
input requests, and authorization events through the existing session inbox; they no longer write
an `eve.task` snapshot stream. The child keeps only execution-local state for admission, abort,
and answer routing. Progress retains its existing stream and delivery behavior.

The first terminal outcome recorded by the parent wins. Duplicate or competing child deliveries
cannot overwrite it. Terminal notifications deduplicate by task, and their model-facing text uses
the parent's recorded outcome. A cohort waits for each terminal notification, including cancellation
already recorded by a control step, before releasing its report. Settlement clears pending task input routes. Coalesced input and spawn
requests are ignored when the same delivery also settles their task; agent settlement still runs
before its ownership lease is released.

`task_cancel` reads the parent's outcome instead of polling a child view. An already recorded
success or failure is returned unchanged. Otherwise cancellation signals the child, attempts
owned-agent cleanup, retains the existing bounded workflow-status wait, and records the cancelled
outcome in the parent. A queued notification ensures cohort reporting also works after forced stop.
The task-view polling loop and stream read timeout are deleted. Startup and reset waits are unchanged.

Validation for this change: all 8,911 unit tests passed (one skipped), and all 82 tests across seven
workflow, cancellation, session, and reset integration suites passed. Typechecking, the production
build, lint, formatting, invariant guards, and published-doc checks passed. The cancellation eval
now checks the retained outcome on the next turn without retrying; it remains CI-only.

The wire registry remains version 1: `terminalView` retains its existing shape, and proxy-input
routes reuse their existing store. Its role is now authoritative parent state rather than an
expired-run cache. No legacy task-stream fallback is added.

## Recommendation

Retain the shared invocation runtime and parent-owned task state. A task settles when the parent
records its outcome; this does not claim that the wrapper workflow has already exited. Workflow
status remains useful for cancellation cleanup, but it does not replace the parent's task result.
An infrastructure failure before outcome delivery still needs separate reconciliation; this change
does not introduce a runtime completion subscription or repair the local runtime cancellation race.

[prototype-invocation]: ../packages/eve/src/execution/tools/workflow/invocation.ts
[prototype-blocking]: ../packages/eve/src/execution/tools/workflow/blocking-owner.ts
[prototype-background]: ../packages/eve/src/execution/tools/workflow/background-owner.ts
[prototype-registry]: ../packages/eve/src/harness/workflow-invocations.ts
