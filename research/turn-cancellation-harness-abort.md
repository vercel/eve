---
issue: https://github.com/vercel/eve/issues/483
status: complete
last_updated: "2026-07-06"
---

# Turn cancellation, layer 0: harness abort propagation

## Summary

Five cancellation attempts (#118/#127/#128/#135, #230, #347) failed to land, and every blocking
failure lived in the _trigger and cross-process_ layers: raced hooks in the non-terminating session
driver (#230), deterministic hook-token reclaim conflicts and duplicate finalizer-step execution
(upstream Workflow bugs blocking #347), and dispatch-adoption races with delegates. The abort
_propagation_ layer, by contrast, was rewritten three times and converged on the same shape each
time. It has never shipped only because it was always chained to the layers that break.

This plan ships the propagation layer alone: the turn harness accepts an optional `AbortSignal` and
honors it end-to-end — model calls, retries, recovery, compaction, and tool execution. No production
code creates or aborts the signal yet, so runtime behavior is unchanged; the layer is exercised by
tests. Each later layer then adds exactly one trigger concern.

## The cancellation stack

Cancellation lands bottom-up. Each layer is independently shippable and reviewable:

```text
layer 4  clients + channels + evals     MessageResponse.cancel(), channel ops, /new, eval controls
layer 3  descendants                    subagent inbox cascade, remote cancel POST, adoption races
layer 2  trigger surface                POST /eve/v1/session/:id/cancel resuming the stable
                                        `${sessionId}:cancel` hook (optional turnId guard)
layer 1  turn-workflow ownership        durable AbortController + cancel race in the terminating
                                        turnWorkflow, cancelled-turn finalizer,
                                        turn.cancelled → session.waiting
layer 0  harness abort propagation      ← this plan
```

Layers 1–2 stay blocked on the two documented upstream Workflow issues (hook dispose-before-reclaim
determinism; duplicate step execution under one correlation id). Layer 0 involves **no hooks, no
routes, no events, and no durable state**, so it has no upstream dependency. Layer 4 semantics
remain governed by `research/channel-session-reset.md`.

## Authoring API

Two small public additions; everything else is internal plumbing.

### `ToolContext.abortSignal`

```ts
export type ToolContext = SessionContext & {
  /** Aborts when the active turn is cancelled. */
  readonly abortSignal: AbortSignal;
  // ...existing members
};
```

Always present. When no upstream signal exists (all of production until layer 1), the harness
supplies a signal that never aborts, so authored code is written once and works unchanged when
triggers arrive.

### Tool execute options

`ToolDefinition.execute` gains an optional second parameter, the AI SDK's per-call tool options
(minus `context`), carrying `toolCallId` and `abortSignal`:

```ts
export type ToolExecuteOptions = Omit<ToolExecutionOptions<unknown>, "context">;
execute?: (input, options?: ToolExecuteOptions) => Promise<unknown> | unknown;
```

## Semantics

- **Absent or never-aborted signal: byte-for-byte unchanged behavior.** The signal is optional at
  every internal seam.
- **Abort during a model call:** the AI SDK call rejects; the harness rethrows `signal.reason`
  without retrying (`runModelCallWithRetries` checks the signal before each attempt and after each
  error) and without entering the empty-response/provider-tool recovery pipeline.
- **Abort during stream consumption:** a stream that ends quietly after abort is caught by an
  explicit aborted-check after stream drain, so the turn can never complete "successfully" from a
  truncated stream.
- **Abort during compaction:** the compaction `generateText` call receives the same signal.
- **Abort during a tool call:** best effort. The AI SDK forwards the call-level signal into every
  tool's execute options; framework tools honor it (sandbox commands, MCP/OpenAPI fetches), authored
  tools receive it via `ctx.abortSignal` and `options.abortSignal` and may ignore it. The harness
  does not wait for a non-cooperating tool: the surrounding model-call promise settles on abort and
  the straggler's result is discarded.
- **Abort is not failure.** A new `isTurnCancellation(error)` classifier (matching the canonical
  serializable cancellation reason, `TurnCancelledError`) is checked before retry/recovery
  classification. `classifyModelCallError` must never return `"retry"` or `"recoverable"` for a
  cancellation. This is the invariant #347's Windows leak violated (`AbortError` escaping into
  `session.failed`); it is pinned by unit tests now so later layers inherit it.
- The cancellation reason must round-trip Workflow step serialization, because layer 1 will observe
  it across a `"use step"` boundary. `TurnCancelledError` is a plain, cause-free error with a stable
  `name` checked by name (not `instanceof`), like `isNoOutputGeneratedError`
  (`harness/model-call-error.ts:279`).

## Implementation seams

The signal enters at `TurnStepInput` and flows one direction. Workflow-core already serializes
`AbortSignal` across `"use step"` boundaries and propagates aborts to running steps in real time
(`.generated/compiled/@workflow/core/workflow/abort-controller.d.ts`,
`serialization/types.d.ts:240`), so this typing is forward-compatible with layer 1's durable
controller.

```text
TurnStepInput.abortSignal?                execution/durable-session-migrations/turn-workflow.ts
  └─ turnStep                             execution/workflow-steps.ts:108
      └─ CreateExecutionNodeStepInput     execution/node-step.ts:48
          └─ ToolLoopHarnessConfig        harness/types.ts:184
              ├─ agent.stream / generate  harness/tool-loop.ts:750, 813
              ├─ post-drain aborted check harness/tool-loop.ts:760 (after emitStreamContent)
              ├─ runModelCallWithRetries  harness/tool-loop.ts:2150
              ├─ recovery pipeline guards harness/tool-loop.ts:~830 catch block
              ├─ maybeCompact → compactMessages   harness/tool-loop.ts:2098, compaction.ts:128
              └─ AI SDK ToolCallOptions.abortSignal (automatic once passed to stream/generate)
                  ├─ wrapToolExecute forwards options   harness/tools.ts:176 (execute(input, options))
                  ├─ HarnessToolDefinition.execute      harness/execute-tool.ts:25
                  ├─ authored ToolContext.abortSignal   execution/tool-auth.ts:53, node-step.ts
                  ├─ sandbox sessions bound to the signal  execution/sandbox/abort-bound-session.ts
                  │   (requireSandboxSession(signal) + ctx.getSandbox(); per-call signals compose
                  │    via AbortSignal.any, so callers can never opt out of turn cancellation)
                  └─ MCP/OpenAPI executeTool(name, args, { abortSignal })
                      runtime/connections/mcp-client.ts:119, openapi-client.ts:98
```

Notes:

- `wrapToolExecute` is the single splice point for all tool kinds; today it drops the AI SDK
  options (`harness/tools.ts:176`). Forwarding them reaches framework, authored, MCP, and dynamic
  connection tools uniformly.
- The sandbox stack already plumbs `abortSignal` end-to-end through every backend (Vercel, Docker,
  just-bash, microsandbox); the framework sandbox tools simply never pass one. Layer 0 turns that
  dead plumbing live, which is where "truly stopping work" (killing a running `bash` command)
  materializes first.
- `harness/tool-loop.ts` has drifted since #347 (e.g. hidden runtime-action tool names in the
  stream branch, `rethrowNoOutputAsEmptyResponse`). Re-derive the diff on main; do not cherry-pick.
- The mock model adapter (`runtime/agent/mock-model-adapter.ts`) gains abort support (#118 had a
  19-line version) so unit tests need no real provider.

## Out of scope for layer 0

- No AbortController is created in production code; no hook, route, event (`turn.cancelled`), or
  client API exists yet.
- No cancelled-turn epilogue: with no trigger, a turn can never abort in production. The epilogue
  (settle → `turn.cancelled` → `session.waiting`) is layer 1, where the failure classification
  seam (`isTurnCancellation`) built here gets consumed.
- No delegate/remote cascade; pending runtime-action batches are untouched.

## Delivery and verification

One PR with a patch changeset covering both halves:

1. **Core propagation** — signal threading (`TurnStepInput` → harness), model-call/retry/recovery/
   compaction handling, `TurnCancelledError` + `isTurnCancellation`, `wrapToolExecute` options
   forwarding, `ToolContext.abortSignal`, docs for the public additions.
2. **Framework tool executors** — sandbox tools pass `options.abortSignal` into `sandbox.run` and
   file I/O; `web_fetch` composes the signal with its timeout; MCP/OpenAPI `executeTool` accepts
   and threads a signal into the underlying request.

Tests (no hooks → unit + integration tiers only):

- unit: retries never resume after abort; recovery pipeline never runs on abort;
  `classifyModelCallError` interplay with `isTurnCancellation`; `wrapToolExecute` forwards options;
  compaction receives the signal; post-drain aborted check.
- integration (`tool-loop-cancellation.integration.test.ts`): a real `ToolLoopAgent` over a
  cancellable `MockLanguageModelV3` — abort mid-stream settles with the canonical cancellation and
  no failure events; an executing tool observes a live signal and its straggler result is
  discarded; an inert signal produces output identical to no signal.
- #347's harness test additions (`tool-loop.test.ts` +45, `tools.test.ts` +50) were the starting
  corpus; its e2e fixture (`agent-cancellation`, `wait-for-cancellation` tool) stays shelved until
  layer 2 provides a trigger.
