---
issue: https://github.com/vercel/eve/issues/1084
status: draft
last_updated: "2026-08-25"
---

# Task-mode graduation

## Summary

Remove `experimental.tasks` after every behavior it currently selects has an ordinary definition-
or session-owned authority. Graduation becomes a deletion-focused minor release, not the place to
invent Workflow execution, task-control effects, callback negotiation, retention, dynamic metadata,
or discovery contracts.

Declared local/remote subagents use their definition-level `background` choice. The built-in
`agent` remains background by default to preserve self-delegation receipts, persistent copies, and
`task_update` behavior used by existing task agents. Blocking self-delegation is intentionally not
added in graduation; changing the framework-owned built-in requires a separate authoring proposal.

## Prerequisites

Graduation starts only after these independent main-targeting PRs land:

1. persistent local/remote subagent sessions and authenticated remote reset on parent finalization;
2. one runtime-action dispatch step with version-safe legacy batch replay;
3. per-subagent blocking/background definitions, nested root-capability projection, mixed prompts,
   fresh-local fanout, built-in `agent` metadata, and dynamic prepared execution mode;
4. generic Workflow tool execution through the shared policy adapter, while blocking subagents keep
   runtime-action interrupts;
5. the stable authored background-tool API and public/private task capability split, including a
   private executor registry that resolves each task kind's cancel, abort, settlement, and
   finalization adapter;
6. durable dynamic background-tool metadata and cold-replay migration;
7. a framework-private task-control effect seam that atomically reads/mutates the adopted session,
   resolves task ownership/world state, and returns one tool result without authored access;
8. versioned remote task-callback capability negotiation;
9. a task-run retention/expiration invariant;
10. machine-readable static/effective execution metadata in versioned build and session surfaces;
11. an explicit durable-format support policy naming the minimum readable session version and
    release range for compatibility readers;
12. published task and migration documentation.

Each prerequisite owns its own changeset, extension epochs, scenarios, and rollout compatibility.

## Public behavior

- Remove `experimental.tasks` from TypeScript and JavaScript agent configuration.
- Background authored tools and `background: true` subagents need no root opt-in.
- Blocking subagents return child output; background subagents return task receipts.
- The built-in `agent` returns task receipts and starts task-owned persistent copies.
- `task_cancel` and `task_update` visibility derives independently from effective session role and
  ownership, not a global flag.
- Workflow/code programs call ordinary/background tools through the shared policy adapter and keep
  blocking subagents through runtime-action interrupts.

Removed `tasks: true` and `tasks: false` both fail with an actionable unknown-key diagnostic. The
compiled manifest version changes and stale build artifacts must be rebuilt.

## Task-control visibility and ordering

The framework-private effect seam makes task controls ordinary execute-capable framework tools
without exposing session mutation to authored tools.

Visibility is per control:

- Upward ownership (this session is a task-owned child) grants `task_update`.
- Downward capability or ownership (an effective background definition or a live owned task) grants
  `task_cancel`.
- A task-owned child with nested background work receives both.
- Authored replacement and `disableTool()` suppress each framework definition independently.

One step-owned transaction orders task controls, ordinary tools, background admissions, and blocking
runtime actions. Control effects commit in provider call order before later conflicting delegation
effects. `task_cancel` versus continuation to the same child, partial failure, and replay semantics
are covered by the effect transaction rather than name-based post-step dispatch.

## Durable compatibility

New prepared definitions and pending batches carry explicit execution. Existing durable state lacks
that field, so graduation uses a versioned legacy inference:

1. An explicit prepared execution value wins.
2. An indexed live task or `addressed` handle is background.
3. For legacy dynamic selections or pending batches, persisted `TasksEnabledKey === true` means
   background; absent/false means blocking.
4. Existing task-control actions remain task controls regardless of the legacy flag.

When an old session runs, eve writes explicit execution into refreshed dynamic selections and new
pending batches. Existing strict handle records remain unchanged because their phase/address already
identifies legacy lifecycle ownership.

`TasksEnabledKey` remains a read-only legacy discriminator for the durable-format range established
by prerequisite 11. It is not removed based on elapsed time: sessions can disable their timeout.
The policy names the minimum readable version, the releases that must retain this reader, and the
write-forward version after which older records fail with an actionable migration error. The
deletion ledger records it as a named compatibility reader, not active mode selection.

Already indexed tasks always derive behavior from their task index/task run, never current
definitions. Existing pending runtime-action batches and Workflow interrupts replay according to
their explicit or legacy-inferred execution under old/new pinned driver capability negotiation.

## Remote callback negotiation

Graduation requires a versioned task callback capability probed before remote child creation. A
versioned sender first reads the receiver's advertised callback protocols, then includes the selected
version in its create-session request. Background dispatch is rejected before child creation and
before returning a receipt when no common version exists. A receiver changing capability between
probe and create rejects the request without starting a child.

The sender persists the selected protocol beside the replay-stable operation ID in the durable
pre-create start/compensation intent before the create side effect. Every retry reuses that protocol;
it does not re-probe and reinterpret an existing create-once operation. If create succeeded but its
response was lost, the create-once owner returns the existing child coordinates even when current
deployment capabilities have changed. The protocol is copied from start intent to the confirmed
child address/task binding, and late-address compensation owns any abandoned result.

- Old task sender → new receiver keeps the shipped unversioned task callback protocol, including
  `taskId`, input, authorization, update, `turn.started`, and terminal payloads. It never downgrades
  to blocking.
- Old blocking sender → new receiver keeps the shipped unversioned blocking callback protocol.
- New sender → old receiver sees no advertised version and rejects a new background admission before
  create. Continuations of existing legacy children keep their pinned unversioned protocol.
- Unknown optional fields are ignored within a selected version; unknown payload kinds fail closed.
- A continuation uses the protocol version pinned on the durable remote child address/task binding,
  not the currently preferred deployment version.

The prerequisite owns all task update, input, authorization, completion, failure, and cancellation
payloads plus cross-version local/Postgres/Vercel fixtures.

## Retention and finalization

The retention prerequisite guarantees one of these before graduation: task-run retention is at
least the owning parent lifetime, or task-run expiration commits a terminal `expired` failure,
caches that view in the parent index, and wakes the parent. A live `working` index entry may never
outlive its routable task run silently.

Parent finalization remains bounded best-effort cleanup: it commits task cancellation where
reachable, aborts task executors, terminates local children, and resets remote children with bounded
retries. Failures are logged/observable and cannot block parent terminal settlement indefinitely.
Normal completion, timeout, explicit reset, unrecoverable failure, and cancellation each invoke the
same cleanup step and share this contract.

A start operation registers a durable compensation intent before its external start side effect.
Finalization marks a `starting` handle abandoned and cancels that operation; if a late start later
publishes an address, the compensation owner immediately terminates/resets the child instead of
making it reachable. Bounded failure records an observable orphan/abandonment outcome. Finalization
does not silently skip `starting` handles.

## Discovery and prompts

Static `/agent-info` and deployment summaries report definition execution and conditionally
available framework controls; they do not claim session-owned live availability. Dynamic resolver
entries report that execution is runtime-selected. A required versioned session-info surface reports
the effective current tool inventory, dynamic execution selection, upward/downward task-control
availability, authored replacement/disablement, and live owned task identities for one authorized
session.

The agent-info schema/version, manifest-only builder, client decoder, and Vercel summary migrate in
the metadata prerequisite. Model-visible prompts and tool descriptions use the effective
session/turn definitions and describe blocking versus receipts without a global task-mode prompt.

## Extension and release contracts

The final flag-removal PR creates a new subagent capability epoch because the reachable
`AgentDefinition` contract loses `experimental.tasks`. Every prior subagent epoch is classified as a
whole declaration contract: retain one only if an adapter can preserve its complete optional-field
behavior without re-exposing the flag; otherwise drop it with a migration reason. Tool and
dynamic-tool epochs belong to the stable background API/dynamic metadata prerequisites. Channel
epochs change only for actual public type/wire changes; no nonexistent `agent` capability is
invented. Retained epochs require behavioral fixtures, not only API hashes.

`TaskMetadata` remains an internal name and is not bundled into graduation. Rename it separately if
mechanical declaration hashes require an epoch, or first define a deliberate public task-view API.

## Final deletion ledger

After prerequisites land, graduation deletes:

- `AgentExperimentalDefinition.tasks`, authored normalization, compiler copy, and manifest field;
- active writes/reads that use `TasksEnabledKey` as current mode (retaining only the versioned legacy
  reader above);
- global “all subagents are background” lowering and prompt selection;
- `isTaskToolAvailable(...tasksEnabled)` gating;
- root-only task-control filtering in `advertised-tools`;
- task-control runtime-action metadata, name sets, and post-step dispatcher branches;
- built-in `agent` mode synthesis from the removed flag (replaced by explicit framework metadata);
- the compatibility adapter that accepts `defineAgent`/`defineRemoteAgent` under subagent paths;
  authors must migrate to the explicit local/remote subagent helpers before graduation;
- docs and fixture configs that author the flag;
- any agent-info fallback that reconstructs execution from experimental config.

Workflow runtime-action metadata remains for blocking subagents. `workflowCallable` and background
tool filtering must already be gone through the generic Workflow prerequisite.

## Verification

Graduation coverage is an explicit compatibility matrix:

- `tasks: true`/`false` diagnostics in TypeScript, JavaScript, root, nested, and stale manifests;
- old task-enabled, task-disabled, and pre-task sessions, including no-timeout sessions;
- old dynamic selections, `TasksEnabledKey`, task indexes, addressed handles, pending task-control
  batches, pending subagent batches, and old/new pinned turn drivers;
- new/old remote sender/receiver negotiation for every callback kind and pinned continuation version;
- accepted remote create followed by a lost response and capability change before replay, proving the
  persisted start-intent protocol and operation ID recover the existing child;
- built-in `agent`, static/dynamic local/remote definitions, nested dual-role task children, task
  controls, authored replacement/disablement, and mixed effect ordering;
- actionable removal diagnostics for legacy static/dynamic `defineAgent`/`defineRemoteAgent`
  subagent forms at root and nested paths;
- task-run expiry while a no-timeout parent remains active;
- finalization failures for task cancel, executor abort, local termination, remote reset, and starting
  children;
- versioned agent-info/static summaries versus effective session visibility;
- static authored background tools with no root opt-in, plus dynamic background selection and cold
  replay of persisted execution metadata with no root opt-in;
- behavioral extension fixtures for every retained epoch;
- deterministic local/Postgres/Vercel task, Workflow, HITL, cancellation, remote-auth, and retention
  fixtures.

## Scope boundaries

Graduation adds no task polling/waiting API, cross-session task sharing, exactly-once authored
external effects, or arbitrary retention configuration. Those require separate public contracts.
