---
issue: https://github.com/vercel/eve/issues/1084
status: draft
last_updated: "2026-08-25"
---

# Per-subagent background execution

## Summary

Let each local or remote subagent definition choose background task execution instead of making
`experimental.tasks` rewrite every subagent owned by an agent. Availability and execution remain
separate: `defineDynamic` decides whether a subagent is exposed for a session or turn; the returned
definition's `background` field decides whether calls return child output or a task receipt.

Background subagents use the existing generic `defineTool({ execution: "background" })` path.
They do not become a new runtime-action variant. Workflow/code programs execute those same tool
definitions through the normal tool executor, with the tool's existing visibility, approval,
authorization, and session capability rules. Code execution adds no separate permission gate.

This is a follow-up redesign of the global behavior shipped for #1084. Definition-level execution
is preferred over per-call model election because authors, not models, own whether work may outlive
the initiating turn; the model can still choose whether and when to call the exposed tool.

## Authoring API

Local subagents use a local definition in their `agent.ts`:

```ts
// agent/subagents/researcher/agent.ts
import { defineLocalSubagent } from "eve";

export default defineLocalSubagent({
  background: true,
  description: "Research complex questions.",
  model: "anthropic/claude-opus-4.8",
});
```

Remote subagents use the corresponding remote definition:

```ts
// agent/subagents/reviewer.ts
import { defineRemoteSubagent } from "eve";

export default defineRemoteSubagent({
  background: true,
  description: "Review a proposed change.",
  url: () => process.env.REVIEW_AGENT_URL!,
});
```

`background` defaults to `false`. A blocking call keeps the parent turn parked until the child
turn resolves. A background call immediately resolves the provider tool call with a task receipt;
later progress, input requirements, and terminal output arrive through the task lifecycle.

`experimental.tasks: true` on the root remains the capability gate. For a static definition,
`background: true` without the root gate is a compile error. For a dynamic definition, the
compiler cannot know the resolver result; runtime resolution logs the invalid selection and omits
that subagent under the existing dynamic-capability failure policy.

The root capability is compiled separately from each child agent's config and projected into every
runtime graph node. Nested subagents therefore receive task infrastructure from the owning root
even though child `agent.ts` files cannot author `experimental.tasks` themselves.

## Conditional exposure

`defineDynamic` remains the only availability mechanism. Its resolver returns a local definition,
a remote definition, or `null`:

```ts
import { defineDynamic, defineRemoteSubagent } from "eve";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      ctx.session.auth.current?.attributes.review === true
        ? defineRemoteSubagent({
            background: true,
            description: "Review a proposed change.",
            url: () => process.env.REVIEW_AGENT_URL!,
          })
        : null,
  },
});
```

Session-scoped selection persists until a runtime-revision refresh; a turn-scoped selection
overrides it for that turn. Returning `null` hides the tool and its execution mode together.

A fresh child uses the currently selected target kind and execution mode. Once a child address
exists, its local/remote target kind and blocking/background mode are pinned to that `agentId`.
Continuing the same ID through a definition that changed either property fails with
`AGENT_MISMATCH`; it never silently starts a new child or converts handle state. Omitted, `null`,
empty, whitespace-only, unknown, or stale IDs preserve current behavior and start a fresh child.

## Definition contracts

`defineLocalSubagent` accepts the full local agent configuration supported by a statically declared
subagent, requires `description`, and adds `background?: boolean`. Dynamic model selection remains
valid in a static local subagent file. A local definition returned from `defineDynamic` retains the
current static-model requirement because its selected config must be durable.

`defineRemoteSubagent` accepts the current remote-agent fields plus `background?: boolean`.
Identity continues to derive from the file path; neither definition accepts `name`.

Both helpers stamp a compiler-visible definition kind. Existing `defineAgent` exports under local
subagent paths and `defineRemoteAgent` exports remain accepted for one compatibility epoch. They
preserve current behavior: under root `experimental.tasks` they normalize to background; otherwise
they normalize to blocking. The compiler emits a migration diagnostic requiring authors to choose
the new helper and explicit `background` value. Dynamic refresh preserves the same legacy rule, so
an unchanged session cannot switch modes only because its runtime revision changes. The following
minor release drops the compatibility epoch rather than carrying permanent aliases. The extension
capability table reflects the support window, and the dynamic remote-agent source transform
recognizes both remote helper names during the transition.

The framework-owned built-in `agent` tool preserves current behavior and remains background while
the root enables `experimental.tasks`. It has no authored definition-level switch in this work. Its
framework description and prompt guidance explicitly say whether the current call blocks for child
output or returns a task receipt; it does not rely on guidance generated only for prepared declared
subagents.

## Compiler and durable representation

`background` is parent-edge policy, not child runtime config. Static compilation stores normalized
`execution: "blocking" | "background"` on the parent-visible `CompiledSubagentNode` or
`CompiledRemoteAgentNode`, never under the child's compiled `agent.config`.

Dynamic normalization returns two values: the existing child runtime config and one prepared
delegation descriptor carrying target kind and execution mode. The durable dynamic selection uses
the prepared descriptor as its single execution-mode source; it does not duplicate the mode in a
sibling field.

The manifest version is bumped. Execution mode does not add a second durable handle field. Existing
handle phase already pins the invocation contract: `addressed` means task-owned background
execution; `starting`, `running`, and `parked` mean blocking execution. Target kind is already
stored on the starting target or confirmed address. A continuation compares the current
definition's target and execution against those durable values before checking occupancy, so
`AGENT_MISMATCH` takes precedence over `AGENT_BUSY`. Existing strict handle records require no
migration or write-forward.

Existing durable dynamic selections and pending action batches remain readable:

- A prepared selection without execution mode means the legacy root-wide behavior:
  `experimental.tasks` selects background, otherwise blocking.
- Existing pending runtime-action batches remain blocking/task-compatible and replay through the
  unified dispatcher.
- Legacy pending runtime-action batches and Workflow interrupts preserve their recorded blocking or
  task-compatible path through the unified dispatcher.
- New fields added to pinned workflow inputs or results are optional and negotiated through a new
  `driverCapabilities` bit and turn-workflow input version. Old pinned drivers never receive an
  unsupported mixed-mode field.

This compatibility is required for persisted sessions and in-flight workflows, not as an authored
API fallback.

## Runtime lowering

Prepared definitions lower independently:

```text
blocking   -> execute-less runtime action -> parent waits for child result
background -> defineTool(execution: "background") -> parent receives task receipt
```

Background definitions stay on the generic background-tool path inside the model tool phase.
Blocking definitions enter the pending runtime-action batch after that phase. The runtime-action
dispatcher does not gain a per-entry background mode.

One model response may contain ordinary tools, blocking subagents, and background subagents. The
provider receives exactly one result for each call:

- ordinary tool output from the synchronous tool executor;
- a task receipt from each background subagent;
- child output from each blocking subagent after the pending runtime-action batch resolves.

The parent model continues only after all synchronous outputs, receipts, and blocking child
results are present. Framework `[Agents]` announcements remain behind any unanswered provider tool
call so they cannot split a call from its result.

The base prompt no longer claims every subagent is background whenever `experimental.tasks` is on.
It documents both receipt and blocking results. Each prepared subagent tool description states its
effective execution behavior, so a dynamic session/turn refresh updates the model-visible guidance
together with the definition.

The model sees one combined `[Agents]` projection. It includes parked blocking handles plus
addressed background handles: available addressed children are resumable, busy addressed children
include their active task identity, and parked blocking children keep their latest status. Starting
or settling one background task cannot remove unrelated parked blocking children from the latest
announcement. One append-only renderer owns ordering/deduplication for the combined list.

## Workflow and code programs

Workflow/code programs consume the same prepared tool definitions as the model loop through the
separate generic Workflow invocation/gate seam. Blocking
subagents retain the existing runtime-action interrupt adapter so programs can await terminal child
output. Execute-capable ordinary and background tools use the normal executor; background calls
return receipts. No `workflowCallable` escape hatch is needed.

The shared seam factors visibility, authored `approval`, connection authorization, task ownership,
session capabilities, context, and instrumentation rather than calling `execute` directly. The code
program itself receives no special permission and cannot bypass a tool gate. A background call
returns its task receipt to the program; the program does not wait for terminal task output unless
it explicitly uses a later public task-waiting API (out of scope here).

## Mixed-mode invariants

- Turn cancellation cancels active blocking child turns. Admitted background tasks survive the
  initiating turn and end through their own lifecycle. Parent-session finalization cancels live
  tasks and terminates or resets child sessions.
- Child occupancy is execution-mode independent. Any nonterminal blocking turn or background task
  makes the addressed child busy. Target/execution mismatch is checked first; otherwise a
  continuation in either mode returns `AGENT_BUSY`.
- Local token fanout uses one denominator across every fresh local child start in the model
  response, regardless of execution mode. Known continuations and remote calls are excluded;
  unknown or stale IDs that fall back to a fresh start are included. All subagent definitions
  register their call shape in one step-scoped batch before child dispatch so background and later
  blocking paths consume the same precomputed count.
- Shared-sandbox setup, active auth, root initiator auth, trace context, and remote principal
  forwarding are identical across execution modes.
- Partial failure settles each provider call once: failed background admission returns a task/tool
  error; failed blocking dispatch returns a subagent error; successful siblings keep their result
  or receipt.

## Delivery and verification

1. Add definition helpers, transition diagnostics, root capability projection, manifest versioning,
   and subagent extension epoch classification.
2. Persist static/dynamic execution mode on parent-visible prepared definitions and pin target/mode
   on child addresses.
3. Lower background definitions through generic background tools and blocking definitions through
   runtime actions; carry one fresh-local-start fanout count across both paths.
4. Make Workflow/code tools use the shared invocation/gate seam: blocking subagents keep runtime
   interrupts, execute-capable tools use normal execution, and no separate permission system exists.
5. Ship published helper, migration, mixed-mode, Workflow, built-in `agent`, and root-gate docs in
   the same release.

Required coverage includes:

- exact public helper types and JavaScript normalization diagnostics;
- unchanged old-helper applications with and without `experimental.tasks`, including dynamic
  runtime-revision refresh, then extension epoch removal;
- static/dynamic, root/nested, local/remote, blocking/background definitions;
- dynamic gate failure, target/mode changes, runtime-revision refresh, old durable selections,
  handle phases, task bindings, pending batches, and Workflow interrupts;
- fresh/known/unknown/stale `agentId` behavior, mismatch-before-busy precedence, and a real
  old-deployment-to-new-deployment continuation;
- mixed ordinary-tool/blocking/background batches, partial failure, result order, and exactly one
  provider result per call;
- fresh-start-only combined local token fanout, cancellation races, sandbox sharing, remote
  auth/credential transforms, mode-aware built-in `agent`, mixed-mode prompts and combined
  parked/available/busy `[Agents]` transitions, existing blocking Workflow
  aggregation, mixed Workflow/code execution, approval/authorization, and parent finalization;
- deterministic local, Postgres, and Vercel fixture evals for static and dynamic background
  subagents.

## Scope boundaries

This work assumes `experimental.tasks` and does not stabilize generic authored background tools,
make task execution the default, remove the capability flag, expose private executor bindings, or
add a public task-waiting API. Those remain separate follow-ups.
