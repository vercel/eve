---
issue: https://github.com/vercel/eve/pull/2690
status: draft
last_updated: "2026-09-01"
---

# Executor-neutral core: removing subagent concepts from execution and harness

## Summary

The workflow-tool graduation (#2690) made the task kernel executor-neutral
(guard rule 41) and the shared subagent workflow body userspace-shaped (rule
42). The layer between them is not neutral: roughly fifty non-test modules
under `packages/eve/src/execution/**` and `packages/eve/src/harness/**` still
name subagent concepts — inbox kinds, delegated-result constructors,
coordination dispatch, dynamic subagent tooling, adapter checks, and depth
limits.

This plan finishes the split. Subagent-specific code moves to a dedicated
executor tree, `packages/eve/src/subagents/`, sibling to the task kernel in
`src/tasks/`. The core keeps only executor-neutral seams: neutral inbox kinds,
a delegation-owner notification contract, a coordination planner, and generic
harness hooks. A new ratcheted guard rule holds the boundary while the work
proceeds and becomes absolute when the baseline reaches zero.

No public API changes. `defineLocalSubagent`, `defineRemoteSubagent`, the
`agent()` workflow helper, receipts, HITL behavior, and channel wire shapes
are unchanged. The only versioned change is internal: session-inbox wire v3
with executor-neutral message kinds, using the append-only wire registry
introduced in #2690.

## Boundary

```
core (executor-neutral)                 executors
─────────────────────────              ──────────────────────────────
src/tasks/**            (rule 41)      src/subagents/**        (new)
src/execution/tasks/**  (rule 41)      src/execution/tools/subagent/**
src/execution/**        (rule 43)      src/execution/tools/workflow/**
src/harness/**          (rule 43)
```

The core may know that a session has children, delegation owners, and
child-originated input requests. It may not know that a child is an agent,
what `subagentName` means, how local differs from remote, or how
`subagent.called` is emitted. Executors translate their protocol into neutral
core contracts at the boundary, mirroring how rule 41 already forces task
executors to translate before reaching `src/tasks/`.

## Phases

### Phase 1 — guard rule 43 (ratchet)

Extend rule 41's concept regex to `src/execution/**` and `src/harness/**`,
excluding `src/execution/tools/subagent/**` and `src/subagents/**`. Seed
`guard-invariants-baseline.json` with the current offenders. Baselines only
shrink, so later phases are mechanically protected from regression and
progress is countable.

### Phase 2 — mechanical extraction

`git mv` the subagent-named modules into `src/subagents/`, import rewrites
only. Candidates (current paths):

- `execution/subagent-adapter.ts`, `subagent-adapter-state.ts` — child-side
  channel adapter
- `execution/subagent-start-local.ts`, `subagent-start-remote.ts`,
  `remote-agent-dispatch.ts` — start paths
- `execution/subagent-tool.ts`, `subagent-invocation.ts`,
  `subagent-task-cancel.ts` — dispatch build and cancellation
- `execution/delegated-parent-notification.ts`,
  `delegated-parent-result.ts` — result wire
- `execution/session-callback-route.ts`, `session-callback-step.ts` — remote
  HTTP callback
- `execution/subagent-event-proxy-step.ts`, `subagent-hitl-proxy.ts` — HITL
  projection and answer splitting
- `execution/agent-handle-dispatch.ts`, `agent-continuation-bundle.ts`,
  `harness/handles/**`, `harness/agent-handle-errors.ts`,
  `harness/subagent-depth.ts` — handle store and lineage

Tests move with their modules. This clears the bulk of the baseline in one
behavior-free PR.

### Phase 3 — neutral seams

The residue is core files that know about subagents. Each needs a contract,
not a rename:

1. **Inbox kinds.** `subagent-input-request`, `subagent-authorization-event`,
   and `subagent-result` become `child-input-request`, `child-authorization`,
   and `child-result`, carrying an opaque executor discriminator. Ships as
   session-inbox wire v3; older versions decode through the existing
   append-only registry. The turn workflow routes by kind to a handler the
   executor registers at bundle build instead of importing
   `runProxySubagentEventStep` directly.
2. **Delegated completion.** `createDelegatedSubagent{Error,Success}Result`
   in `workflow-entry.ts` becomes a neutral delegation-owner notification the
   executor serializes into context. The entry workflow knows only "notify
   this session's delegation owner on terminal state".
3. **Coordination dispatch.** `coordination-dispatch-shared.ts` splits into a
   neutral planner (batching, replay-safe emission, failure mapping) and a
   subagent executor module owning target resolution and `subagent.called`
   emission. Largest single review unit; its own PR.
4. **Harness residue.** Dynamic subagent tools in `tool-loop.ts` become a
   generic dynamic-tool-source hook; `SUBAGENT_ADAPTER_KIND` checks become a
   capability flag on adapter state; `workflowMaxSubagents` becomes a generic
   child-run concurrency limit keyed by executor.

### Phase 4 — ratchet to zero

When the rule 43 baseline is empty, the rule graduates to absolute, matching
rule 41.

## Non-goals

- **HITL obligation state.** `eve.runtime.pendingInputBatches`,
  `eve.runtime.proxyInputRequests`, and `harness/hitl/**` keep their shapes.
  This plan relocates and renames routing around the stores; reshaping them is
  the HITL request-lifecycle unification (#2652). Its interpreter later lands
  behind the same neutral seams as one more consumer, avoiding the
  dual-authority problem its research doc identifies.
- **Public authoring surface.** No changes to definitions, receipts, events,
  or channel wire.
- **New executor kinds.** The seams admit them but none ship here.

## Sequencing

Phases 1–2 are independent of all in-flight work and can land immediately
after #2690. Phase 3 item 1 touches the routing files #2652's implementation
will also touch; whichever lands second rebases on import paths, not
semantics. If #2652 implementation starts first, it should adopt the neutral
inbox-kind vocabulary so kernel projection routes are born executor-neutral.
