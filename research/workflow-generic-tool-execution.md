---
issue: https://github.com/vercel/eve/issues/1084
status: draft
last_updated: "2026-08-25"
---

# Generic tool execution in Workflow programs

## Summary

Let model-authored Workflow programs call effective eve tool definitions without a Workflow-only
permission system. Blocking subagents retain the existing runtime-action interrupt path. Ordinary
and background execute-capable tools use a new harness-owned call adapter that applies the same
visibility, approval, authorization, context, task, event, and disclosure policies as model-loop
calls.

The code sandbox is isolation, not authorization. QuickJS never receives raw output that
`toModelOutput` hides, and it cannot bypass approval or connection authorization.

This is the execution prerequisite for per-subagent background mode. It is not a small filter change
inside `createWorkflowHostTools`; current tool policy is split across AI SDK approval callbacks,
post-step interrupt handling, background task scope, and instrumentation, so those concerns must be
factored into one eve-owned invocation seam first.

## Effective tool inventory

Build one canonical effective `HarnessToolMap` before deriving either model tools or Workflow host
tools. It includes static tools, dynamic tools, static/dynamic subagents, authored replacement and
disablement, caller-shape filtering, framework visibility, and provider-tool exclusions. Existing
origin-specific precedence remains unchanged: authored static tools replace same-named framework
defaults; a dynamic ordinary tool may replace a same-named ordinary tool after filtering but cannot
shadow any runtime-action entry (delegation or task control) or any static/dynamic subagent; and a
dynamic subagent colliding with any runtime-visible tool fails resolution.

Every prepared entry carries eve-owned origin metadata (`authored-tool`, `local-subagent`,
`remote-subagent`, or framework kind), source identity, and an effective revision. This work first
adds one canonical implementation revision to compiled module bindings and prepared tools. For a
filesystem module it derives from compiled content identity; for a programmatic module it derives
from `semanticRevision ?? source.revision`. Static tool revision then hashes that implementation
revision with definition origin/owner, source ID, logical path, static kind, schemas,
execution/delegation metadata, approval/projection phase identities, and the model-visible
description.

Dynamic resolver metadata persists resolver owner/origin, source ID/logical path, and implementation
revision. Each registered callback
phase (`execute`, approval request/response, `toModelOutput`) also carries the implementation revision
of the compiled module that registered the current `(toolName, phase)` binding; closure remains the
only authored value persisted in the callback reference. A dynamic effective revision hashes those
phase revisions plus canonical closure JSON, dynamic kind, resolver source identity/revision, scope
coordinate, resolver slug, entry key, serialized schemas, origin/execution/delegation metadata, and
description. This changes the current latest-code
callback registry into a revision-verifiable binding for parked Workflow calls without resurrecting
the removed callback `stepId` format. Definitions without enough durable revision material are
unavailable to a resumable Workflow call.

Workflow exposure follows the effective entry:

```text
blocking local/remote subagent -> existing runtime-action interrupt
execute-capable definition     -> generic Workflow call adapter
provider-managed/no execute    -> not exposed
task-control runtime action    -> not exposed
```

`workflowCallable` is removed after this inventory exists. Execute capability and supported
delegation metadata determine callability; a name check never does.

Dynamic ordinary tools are included only after their execution mode, source revision, and durable
metadata are represented in the effective map. Until then they remain explicitly unavailable to
Workflow. Dynamic subagents are supported because their prepared descriptor already persists in the
dynamic selection; per-subagent background work extends that descriptor with execution mode.

## Shared call adapter

The adapter owns one nested call from validation through settlement:

1. validate input with the effective tool schema;
2. evaluate authored approval against current session approvals and `approvalKey`;
3. execute through `createToolExecuteWithAuth` and the active eve context;
4. convert authorization signals into a private interruption, never a successful result;
5. run foreground or background execution through the current step-owned execution scope;
6. normalize output to JSON-safe data and emit ordinary action/instrumentation lifecycle events;
7. apply `toModelOutput` and return its validated tagged projection to QuickJS.

Output schema behavior matches ordinary tools: eve forwards the schema to the tool surface but does
not add Workflow-only output validation. Async iterable tools publish `action.partial` snapshots
through the normal lifecycle while QuickJS receives only the final value.

`toModelOutput` remains a disclosure boundary. QuickJS is model-authored code, so each nested call
receives exactly the same projection the model would receive from a direct call. The sandbox-visible
ABI is the validated tagged union:

```ts
type WorkflowToolOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: JsonValue }
  | { type: "content"; value: ToolModelOutputPart[] };
```

Workflow host wrappers advertise this union as their output schema, and generated program signatures
return `Promise<WorkflowToolOutput>` rather than the authored raw `outputSchema`. Programs inspect
the tag and consume `value`; they never receive hidden raw fields. The authored `outputSchema`
continues to describe the direct tool result and is not reused for this projected ABI. The full
output remains available to channel events, hooks, and private instrumentation according to existing
content policy. No `toProgramOutput` API is added.

## Approval and authorization interruptions

The call adapter does not invoke `execute` while user approval is pending. It raises a sanitized
Workflow host interrupt containing the nested call ID, tool revision, tool name, and input hash. An
eve-owned pending Workflow envelope stores the private approval request and the dependency-owned
signed code-mode continuation separately.

Approval follows the normal session path:

```text
nested call
  -> evaluate approval with current auth/session approvals
  -> not applicable/already approved: execute
  -> user approval: persist eve input request and park
  -> before consuming a response, verify the current effective revision still matches the parked call
  -> stale: resolve a stale-tool result without invoking response policy or recording approval
  -> denied: resolve this nested promise with the ordinary denied tool result
  -> approved: evaluate the bound response policy, record approval/approvalKey, continue execution
```

Several `Promise.all` calls may request approval. The envelope records every pending ledger entry,
forms the normal ordered input batch, and resolves each QuickJS promise independently. Revision
verification occurs before consuming an Allow/Deny response, creating an approval candidate,
current-definition response authorization, candidate settlement, approval-key calculation, or any
write to session approvals. A stale response therefore creates no responder-bound candidate state
and cannot authorize a replacement tool. Existing response authorization and approval-candidate
settlement remain authoritative after that check.

An `AuthorizationSignal` is intercepted before model projection. Secret-bearing OAuth URLs, user
codes, hook URLs, and resume strategy data remain in private pending authorization state. The signed
Workflow interrupt contains only an opaque candidate ID and sanitized description. After callback,
eve verifies the effective tool revision and resumes the exact nested call with current-turn auth.

Approval and authorization use the existing `park` driver arm. Blocking subagent actions keep the
existing `dispatch-workflow-runtime-actions` arm. No new driver discriminant is introduced.

## Heterogeneous interruption coordinator

One signed code-mode ledger may contain fulfilled calls plus pending approvals, authorizations, and
blocking subagents. The eve-owned envelope classifies every interrupted ledger entry by domain:

- immediately dispatch blocking subagents allowed by the current subagent budget;
- emit all ready approval/input requests as one durable batch;
- retain private authorization challenges until their callbacks settle;
- keep fulfilled ordinary outputs and admitted background receipts in the ledger;
- feed each resolution to its exact nested `toolCallId` in ledger order.

Work that does not depend on human input may proceed while approval or authorization is pending.
The parent model remains parked until the Workflow program completes or fails. Denial, unavailable
tools, dispatch failure, and authorization failure resolve only their corresponding nested promise;
normal JavaScript error handling decides whether the program continues.

The dependency's signed `CodeModeContinuation` remains opaque version 1. eve wraps it in a
versioned pending-Workflow envelope that owns domain classification, private state, tool revisions,
and resolutions. Pinned turn workflows receive only additive optional fields on existing action
arms and advertise support through `driverCapabilities`.

## Background calls

`runBackgroundStep` remains the sole owner of one `BackgroundToolExecutionScope` for the durable
turn step. Workflow host calls never instantiate or serialize a second scope.

Concurrent code-mode calls require two-phase admission. The Workflow bridge collects one ready
cohort of nested requests, registers every background call and the total fresh-local-subagent
fanout, then releases execution. Timing-based microtask batching is not sufficient; the vendored
code-mode bridge must expose an explicit pre-execution cohort callback (or equivalent request
barrier) before background support lands.

`TaskExec.batch` then retains its current sibling invariant. Background task IDs derive from the
exact signed nested `toolCallId` (`<outerCallId>:tool-N`), not the lossy sanitized
`toolName + interruptId` ID currently used by runtime-action reconstruction.

Once a background call is durably admitted, it survives a later uncaught Workflow program error,
matching the step-owned task lifecycle. The program receives a task receipt, not terminal output.
Selective per-program rollback is not introduced. A failure before the step or continuation ledger
commits may rerun the outer model call with a different outer ID; authored external operations still
require their own idempotency key.

## Definition revision and resume

A parked approval or authorization binds to the effective tool revision that produced it. On
resume, eve rebuilds the effective inventory and compares revisions before execution. A replaced,
removed, hidden, or dynamically changed definition fails closed with a named stale-tool result; it
never executes a different same-named function under an old approval.

Blocking runtime-action interrupts continue carrying their prepared target. Generic call
continuations store only eve-owned serializable identity and private pending state, never function
objects or credentials.

Continuation resumes pass the active turn's abort signal and current messages into code mode's
`toolExecutionOptions`, restoring `ToolContext.abortSignal`, abort-bound sandbox access, and current
auth/context behavior.

## Limits

Workflow has independent limits for:

- total nested calls (`maxToolCalls`, default 256);
- subagent calls (`maxSubagents`, existing default 100);
- concurrently executing host calls (`maxConcurrentCalls`, default 16);
- per-call input/output bytes (existing code-mode limits);
- aggregate serialized continuation bytes (`maxContinuationBytes`, default 16 MiB).

The aggregate continuation limit applies to canonical serialization of the entire eve-owned pending
Workflow envelope: the signed dependency continuation, domain classifications, tool revisions,
inputs/resolutions, approval requests, private authorization state, and response messages. It is
checked on the initial park and before every subsequent persistence, returning a named Workflow
limit error. `maxBridgeRequests` follows `maxToolCalls`, not `maxSubagents`; ordinary calls consume
the total call budget but not the subagent budget. Node-side concurrency never follows the current
256-request bridge ceiling.

## Security and observability

- QuickJS keeps host `fetch`, imports, process globals, and direct sandbox access disabled.
- The effective tool is the only capability boundary; code mode adds no permission bypass.
- Task controls stay unavailable because they are execute-less runtime actions, not generic tools.
- Connection authorization and approval secrets remain outside signed/model-visible continuations.
- Nested calls emit the same action lifecycle and tool instrumentation as direct calls, including
  partial snapshots; Workflow program telemetry nests those spans under the outer Workflow call.
- Errors returned to QuickJS use the same safe model-facing shape; private details remain in logs and
  instrumentation according to content policy.

## Delivery

1. Build the canonical effective tool inventory and stable tool revision metadata.
2. Factor approval evaluation, raw execution, authorization interruption, output projection, events,
   and instrumentation into the shared call adapter.
3. Add the eve-owned versioned pending-Workflow envelope and heterogeneous coordinator.
4. Extend the vendored code-mode bridge with explicit cohort admission and aggregate ledger limits.
5. Expose execute-capable tools while retaining runtime-action adapters for blocking subagents;
   remove `workflowCallable` and use exact nested call IDs.
6. Add public Workflow options for total calls, concurrency, and continuation bytes; update published
   Workflow/tool/security documentation and add a patch changeset.
7. Add per-subagent background definitions only after generic background calls pass all worlds.

Required coverage includes raw-output redaction through `toModelOutput`, approval allow/deny and
multiple pending approvals, and stale approval rejection before candidate creation. Inventory tests
cover authored replacement/disablement of framework defaults; dynamic ordinary versus authored
ordinary precedence; dynamic ordinary collisions with every runtime-action kind including task
controls; dynamic-subagent collisions; session/turn/step dynamic precedence; caller-shape visibility;
and provider-managed exclusions. Parked-call tests cover static and dynamic definitions that are
removed, hidden, schema-changed, projection-changed, approval-policy-changed, closure-changed, or
implementation-revision-changed, plus framework-to-authored, authored-to-framework,
static-to-dynamic, dynamic-to-static, source-ID/logical-path, owner/origin, and resolver-source
replacement transitions even when all other content matches. Remaining coverage includes OAuth authorization privacy/resume,
blocking/background subagents, mixed `Promise.all`, exact call IDs, cohort fanout, task admission and
program-error survival, process interruption before/after ledger commit, partial results,
instrumentation, cancellation, all limits, old pinned drivers, and deterministic local/Postgres/
Vercel Workflow fixtures.

## Scope boundaries

This work does not expose raw tool output to model-authored code, expose execute-less task controls,
add selective rollback for one Workflow invocation, add a public task-wait API, or let authored
application code submit Workflow programs. The model remains the only author of the experimental
Workflow program.
