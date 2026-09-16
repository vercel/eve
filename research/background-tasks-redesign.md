---
issue: https://github.com/vercel/eve/issues/1084
status: draft
last_updated: "2026-09-15"
---

# Background tasks: one workflow invocation runtime

**Prototype result: viable, with a retained task lifecycle.** One durable workflow invocation
runtime now executes both waiting and background workflow tools. Requiring workflow-backed
background work and removing authored parent messages deletes enough alternate execution code to
make the consolidation smaller than the baseline. The session-owned task lifecycle remains
necessary for admission, cancellation finality, human input, reusable child ownership, accounting,
and cohort delivery.

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

`createWorkflowToolInvocationReader` is the sole workflow-body execution owner. It starts
`executeWorkflowBody`, owns the internal workflow inbox, drains every persisted report, and emits
the existing `WorkflowToolRunMessage` outcome only after those reports are consumed.
[Shared invocation][prototype-invocation]

The foreground adapter consumes that stream and keeps its existing turn-bound cancellation policy.
The background task owner creates the same stream only after `ready`; its admitted work therefore
remains session-bound and survives the initiating turn. [Foreground adapter][prototype-blocking],
[background adapter][prototype-background]

| Concern                             | Before                                                        | Prototype                                 |
| ----------------------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| Workflow-body execution owners      | 2 direct callers of `executeWorkflowBody`                     | 1 shared invocation reader                |
| Background executor implementations | Workflow body or inline `defineTool` body                     | Workflow body only                        |
| Durable workflow kinds              | Foreground workflow-tool run and background task run          | Unchanged; no extra run                   |
| Mutable lifecycle writers           | Foreground run record and background `TaskView` writer        | Unchanged; each lifetime keeps one writer |
| Persistent records                  | Harness workflow-tool-run record and session task-index entry | Unchanged; no result ledger added         |
| Authored background protocols       | Return/yield plus `TaskExec`/`TaskMessage`                    | Return/yield plus workflow context        |
| Terminal report classifier          | Successful `:ready:completed` delivery ID suffix              | Owned terminal `TaskView` payload         |

This does not remove background tasks as a lifecycle concept. It removes background execution as a
second way to run authored code. A task still represents admitted session-owned work; the workflow
invocation reader is the common executor inside that owner.

## What was eliminated

The prototype deletes these responsibilities rather than renaming them:

- Parent-step execution of ordinary background tool bodies, async-iterable drainage, authorization
  return handling, and final task-command delivery.
- Lifecycle-only task runs with no workflow body and the optional no-body branch in
  `TaskRunWorkflowInput`.
- Two `TaskExec` constructors, `TaskMessage` detection, message buffering, and the dedicated
  task-message parent wake step.
- Background dynamic-tool persistence and replay.
- Success-only cohort classification based on a delivery ID suffix.

These responsibilities were retained or relocated:

- Body start, report drainage, and outcome construction moved into the shared invocation reader.
- Admission, compensation, child reservation/claiming, steering, task cancellation, and session
  indexing remain in the task owner.
- Foreground workflow-tool-run records and background task records remain separate projections
  because they have different ownership lifetimes.
- The session input queue still buffers active-turn deliveries and performs cohort release.

## Size comparison

Against the current base, the prototype changes 26 production files under `packages/eve/src` with
265 additions and 581 deletions: **316 fewer production lines**. This includes the new 69-line
invocation owner. No file is a verbatim move; the shared owner recomposes ordering logic formerly
split across the foreground workflow run and background task owner.

Fifteen test and test-support files change by 274 additions and 413 deletions: **139 fewer test
lines**. Two obsolete unit files for the removed inline background and `TaskMessage` APIs are
deleted. Fixture edits add 6 and delete 6 lines.

The reduction is material because the public surface and runtime branches shrink together. In the
initial experiment, sharing the executor while retaining both authoring paths increased the bounded
runtime scope by 42 lines. Applying the approved deletions made the implementation smaller than its
base. The common invocation owner is worth retaining only with those scope reductions.

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
Explicit cancellation still settles and records the task before task-owned work is stopped; the
existing cancellation delivery ID provides deduplication. Steering cancellation continues to mark
superseded task deliveries for suppression.

## Compatibility and migration

This is a breaking authoring change, so the prototype includes a minor changeset and updated public
docs. Extension capability generation records `tool` epoch 45 and `dynamicTool` epoch 42. It also
drops retained epochs that explicitly exercised the removed surfaces: tool epoch 28, dynamic-tool
epochs 28–30, and the previous current epochs 44 and 41.

Migrate an ordinary background definition by replacing `defineTool` with `defineWorkflowTool`,
adding `"use workflow"`, moving nondeterministic side effects into `"use step"` helpers, removing
the third executor argument, and replacing parent messages with progress or the final return value.
A dependency on an intermediate result belongs inside the owning workflow through `ctx.agent`,
`ctx.ask`, or another durable operation.

## Demonstrated behavior

| Requirement                                                   | Evidence                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| Waiting workflow completion, failure, and progress            | Workflow integration suite                                            |
| Background receipt before later completion                    | Workflow integration suite exercises both root and child owners       |
| Commit before body start                                      | Task-owner unit test creates the invocation reader only after `ready` |
| Report before outcome                                         | Shared invocation unit test and task-owner report/outcome test        |
| Explicit cancellation wins over late completion               | Task-owner unit test                                                  |
| Workflow human input and authorization routing                | Workflow integration suite and task-owner authorization tests         |
| Mixed success/failure and success/cancellation report         | Parked delivery unit tests                                            |
| All-failed and all-cancelled report                           | Parked delivery unit tests                                            |
| Active parent does not steer on terminal failure/cancellation | Turn-control receiver unit test                                       |
| Duplicate terminal delivery                                   | Existing parked-delivery deduplication unit test                      |
| Cross-turn cohort membership                                  | Existing parked-delivery cross-turn unit test                         |
| Forced-stop cancellation notification                         | Cancellation integration test                                         |
| Extension migration boundary                                  | Generated capability reports and invariant guard                      |

Exact checks run in this worktree:

- Full unit tier: **797 files passed; 8,667 tests passed; 1 skipped**.
- Workflow/task integration slice: **2 files, 41 tests passed**.
- Forced-stop cancellation integration: **1 file, 1 test passed**.
- TypeScript `--noEmit`, fresh production TypeScript/Rolldown build, focused lint, formatting,
  `git diff --check`, extension-contract generation, and `guard:invariants`: passed.
- Documentation frontmatter/navigation, import snippets, and MDX compilation: passed for all 89
  published pages.

The normal package-manager wrapper remains unavailable in this checkout because the private
registry requires `SOCKET_PASSWORD_B64`. Dependencies were installed from the local store with a
frozen lockfile, and the underlying checks were invoked directly. No credential value was read or
printed. Local E2E was not run because the repository marks it CI-only.

## Remaining proof gaps and migration risks

The prototype does not yet demonstrate these full boundaries:

- An explicit initiating-turn cancellation racing after task admission while the background body
  remains blocked. Ownership is unchanged and existing retention code covers this path, but the
  exact combined prototype path lacks a dedicated test.
- One end-to-end model-call assertion that active-parent buffered terminal outcomes later become a
  single report. The tests separately prove active buffering and parked cohort release.
- Parent-session finalization cancelling a currently blocked invocation through the new reader.
- Reusable-child steering with a late superseded success through the complete combined path.
- Replay at the exact parent commit/`ready` boundary and a crash during final cohort release.

Removing the optional workflow body also changes replay compatibility for an already-running
lifecycle-only task created by an older deployment. A production rollout needs deployment pinning
or a drain/migration plan for those in-flight runs; the prototype does not provide a legacy fallback.

Delaying automatic failure output behind a slow sibling is an intentional behavior change. Task
state and activity still show failure promptly, but the model does not receive the failure as
conversation input until the cohort closes. Long-lived overlapping cohorts can therefore delay the
automatic report. No new timeout or grouping option was added.

The framework `agent` tool remains an internal exception to authored compilation: its definition is
runtime-rebound to the shared subagent workflow. The compiler exemption is limited to the existing
`self-agent` handling marker; authored background tools without a workflow ID fail with a migration
error.

## Recommendation

Retain the shared invocation runtime and the three approved scope reductions as one change. Do not
replace `TaskView` or the session task index with raw Workflow status: doing so would discard
`input_required`, final cancellation ownership, child identity/accounting, and replay-stable cohort
membership. Before production merge, add CI E2E coverage for the combined-path gaps above,
especially initiating-turn cancellation and active-parent report release.

[prototype-invocation]: ../packages/eve/src/execution/tools/workflow/invocation.ts
[prototype-blocking]: ../packages/eve/src/execution/tools/workflow/workflow.ts
[prototype-background]: ../packages/eve/src/execution/tasks/child/workflow.ts
