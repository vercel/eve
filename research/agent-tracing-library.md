---
issue: TBD
status: in-progress
last_updated: "2026-10-15"
---

# Agent tracing library

## Summary

Agents outside eve need the same trace topology, capture rules, and durable
recovery that eve has, without adopting eve's runtime. This plan extracts a
framework-neutral library, `@vercel/agent-runs`, with one constructor:
`createAgentRun`. The host passes an `AgentTelemetry` object that writes
spans and, for durable turns, a `TraceCheckpointer`. The library owns span
topology, capture, completion, checkpoint keys, and hydration. A durable turn
resumes when the host calls the same operations again, in any process.

eve becomes the first consumer. Trace schema version 4, span names, topology,
and durable span IDs stay unchanged.

The work is split into a stack: this plan (#4158), the library (#4160), and the
eve migration (#4164).

## Entrypoints

| Entrypoint                      | Contents                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vercel/agent-runs`            | `createAgentRun`, `otelTelemetry`, `AgentSpanIdGenerator`, operation and telemetry types, `currentCapture`                                     |
| `@vercel/agent-runs/delegation` | Local handoff context and the remote delegation transport                                                                                      |
| `@vercel/agent-runs/ai-sdk`     | `aiSdkTelemetry` and the AI SDK payload helpers `modelUsage` and `modelContent`                                                                |
| `@vercel/agent-runs/otel`       | Plumbing for hosts that run their own spans beside agent tracing: active-operation lookup, capture context, content bounds, and MCP enrichment |

The root depends only on `@opentelemetry/api`. Only `./ai-sdk` uses `ai`, as an
optional peer dependency. Hosts cannot import private modules; the invariant
guard (rule 52) enforces this.

The library lives in `packages/tracing` and is published as
`@vercel/agent-runs`. Its constructor and types use the singular `AgentRun` name.
eve vendors it the way it vendors `@eve/catalog`: `build:compiled` bundles the
four entrypoints into
`#compiled/@vercel/agent-runs/`, in the same chunk group as eve's vendored
`@opentelemetry/api`, so the published eve package carries one OpenTelemetry
copy and no new runtime dependency. eve imports only those vendored
entrypoints.

## Construction

```ts
const run = createAgentRun({
  telemetry: otelTelemetry({ provider, idGenerator, samplesTrace, mapping }),
  checkpointer, // optional: makes turns durable
  serializer, // optional: defaults to the AI SDK content serializer
  onError, // the only tracing error channel
});
```

`AgentTelemetry` is a library-owned, OTel-shaped interface: `startSpan`,
`active`, `run`, `suppressed`, `samples`, optional stable `ids`, `forceFlush`,
and `shutdown`. `otelTelemetry` adapts an OpenTelemetry tracer provider and
does not register global telemetry. Other backends implement the interface
directly. Sampling and output mapping belong to the telemetry object.

A checkpointer requires `telemetry.ids`. Without them, construction throws an
error that names `AgentSpanIdGenerator`.

## Operations

```text
turn ─┬─ attempt ─┬─ modelCall
      │           └─ tool ─┬─ approval
      │                    └─ tool     (a call made while the tool runs)
      └─ memory   (also under attempts and tools)
```

Each tool call is one `execute_tool` span. A host often learns about a call
twice: the runtime records its dispatch, and the SDK reports its run. In a
durable turn, calling `attempt.tool()` again with the same `callId` returns the
same call and fills in what the first report lacked, such as `kind`,
`arguments`, or an earlier start time. Tools with `kind: "subagent-call"` or
`"remote-agent-call"` delegate to another agent.

### Wrapped and handle forms

Each operation has two forms. The wrapped form runs a callback inside the
operation, returns its value or rethrows its error, and completes the operation
either way. An optional `describe(value)` maps the value to a completion, such
as an outcome or captured output:

```ts
await run.turn({ agentName: "support", identity, sequence: 0 }, (turn) =>
  turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
    attempt.tool({ callId: "lookup", name: "lookup" }, lookup),
  ),
);
```

The handle form omits the callback and returns the operation. Hosts whose
start and end arrive in different hooks, or different processes, hold the
handle and complete it themselves:

```ts
const turn = await run.turn({ agentName: "support", identity, sequence: 0 });
const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
const tool = await attempt.tool({ callId: "lookup", name: "lookup" });
try {
  const value = await tool.run(lookup);
  await tool.complete({ outcome: "completed", output: value });
} catch (error) {
  await tool.fail(error);
}
await attempt.complete();
await turn.complete();
```

### Handles

Every handle shares one interface:

```ts
interface Operation {
  readonly type: "activation" | "step" | "model" | "tool" | "approval" | "memory";
  readonly reference: TraceReference; // trace and span ID, stable once started
  readonly parent?: TraceReference;
  readonly startTimeMs: number;
  readonly finished: boolean;
  readonly capture: CaptureDecision;
  run<T>(execute: () => T, ceiling?: CaptureDecision): T;
  attributes(attributes: Attributes): void;
  complete(result?: Completion): Promise<void>;
  fail(error: unknown): Promise<void>;
  recordError(error: unknown, errorType?: string): void;
}
```

- `run(execute, ceiling)` makes the operation active while `execute` runs, so
  spans that other libraries start inside it become its children. The ceiling
  limits captured content for work inside the run; it does not remove what the
  operation already recorded, and it bounds content any operation receives
  while the run is active.
- `complete(result)` ends the operation and is idempotent. The completion can
  carry `outcome`, `failed`, `error` and `errorType`, `output`, `usage`, a model
  `result`, and `endTimeMs`. `outcomeUnknown: true` ends a turn without an
  outcome when the host never learned one; a failure is still recorded.
- `fail(error)` completes the operation as failed. `recordError(error)` marks
  it failed without ending it, so a completion reported later, possibly by
  another process, stays failed.
- Completing a parent closes its unfinished children, except as described in
  [Lifetimes](#lifetimes).

Handles add the operations that may start beneath them:

| Handle                  | Starts                                                                          | Finds                                                     |
| ----------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| turn                    | `attempt`, `memory`                                                             | `findAttempt({ stepIndex, attempt })`, `findTool(callId)` |
| attempt                 | `modelCall`, `modelStream`, `tool`, `callSubAgent`, `callRemoteAgent`, `memory` |                                                           |
| tool                    | `approval`, nested `tool`, `memory`                                             | `findApproval(requestId)`                                 |
| model, approval, memory | nothing                                                                         |                                                           |

`turn.links()` replaces the turn's links before its deferred span is exported.
`modelStream` returns the stream unchanged and completes when its `completion`
promise settles, not when the callback returns; parent completion waits for it. Find operations return `undefined` once the operation has
finished, and are available only in durable turns.

### Turn input

`TurnInput` carries `identity` (`conversationId`, `runId`, `turnId`),
`agentName`, `sequence`, framework metadata, a capture decision, and
attributes. Durable hosts can also supply:

- `reference`: a trace and span ID reserved before the turn started, such as a
  seed already returned to a caller. The sampler still decides the trace flags.
- `lineage` and `channel`: delegation and delivery metadata the host stores
  itself, when no in-process handoff carries it.
- `parent`: the caller's span, for a turn that nests in its caller's trace.
- `links` and `startTimeMs`. `turn.links()` replaces links that the host learns
  after the turn starts.
- `context`: host execution context, such as OTel baggage, for spans this
  process starts.

`agentName` belongs to the turn, so one instance can trace several agents.

## Durable turns

```ts
interface TraceCheckpointer {
  get(key: string): unknown | PromiseLike<unknown>;
  set(key: string, value: TraceSnapshot): void | PromiseLike<void>;
  delete(key: string): void | PromiseLike<void>;
}
```

- **Keys.** The library chooses keys. A turn is stored at `turn:<runId>:<turnId>`.
  Inside the tree, attempts are keyed by step index and attempt, tool calls by
  `callId`, and approvals by `requestId`. Model calls and memory are numbered
  and get new span IDs when they run again, because a re-run is new work.
- **Writes.** The library writes JSON after each change, in order. It deletes
  the entry when the turn and all of its open work have completed. Each node is
  capped at 64 KiB, and finished children leave the tree.
- **Resume.** Calling `turn()` with the same identity continues the saved turn.
  `run.resume({ identity })` returns a saved turn without starting one.
  `turn.findAttempt()`, `turn.findTool(callId)`, and `tool.findApproval()`
  return open operations, or `undefined`.
- **Deferred spans.** Durable turns, tool calls, and approvals reserve their IDs
  at start and export at completion, so a later process can complete them.
  Attempts and model calls are live spans in the process that runs them.
- **Process cache.** Concurrent hooks in one process share one tree. Each write
  stores a revision token; when another process changed the checkpoint, the
  next call reloads it.
- **Failures.** An unreadable checkpoint is reported to `onError` with phase
  `restore`, and a fresh turn starts. Write failures use phase `checkpoint`.

### Lifetimes

| Event                               | Open children                                            |
| ----------------------------------- | -------------------------------------------------------- |
| Any operation fails                 | Closed as failed                                         |
| A non-durable operation completes   | Closed as abandoned                                      |
| A durable attempt or turn completes | Tool calls and approvals stay open; other children close |
| A tool call completes               | Its nested calls and approvals close                     |

Tool calls outlive their attempt and turn because human approval parks a turn:
the approval resolves in a later turn, and its span still belongs to the
original call.

## AI SDK integration

`aiSdkTelemetry(run, { turn })` returns an AI SDK `Telemetry` integration
for `generateText`, `streamText`, and agents such as `HarnessAgent`. It keeps
open operations keyed by the SDK `callId` and `toolCallId`, so hosts do not
store handles between hooks. It runs model calls and tools inside their spans
through `executeLanguageModelCall` and `executeTool`. `turn` can be a function
that chooses the turn for each call.

## Capture and delegation

Capture defaults to metadata only. Children cannot increase capture, and
declined content never enters a checkpoint. Content is checked when it arrives:
an operation's own capture, narrowed by any run ceiling active at that moment,
decides whether arguments, results, and errors are kept. Re-entering a turn with
a narrower capture narrows it and its open operations and drops retained
content the new decision declines; content recorded under earlier consent is
kept. Failure classes survive redaction;
exception messages do not. Serialized content is capped at 32 KiB.

Local delegation carries lineage through async context. A local callee's first
turn nests under the delegating tool call in the caller's trace; later turns
start their own trace. Remote delegation uses a bounded `x-agent-tracing`
header; the receiver validates it and asks the host to verify the authenticated
caller before it adopts any lineage. A remote callee starts its own trace with
an `agent.dispatch` link to the call.

## eve as consumer

eve uses one `AgentRun` instance over `otelTelemetry`. Its checkpointer
stores trees in the existing workflow-context trace state, so checkpoints commit
with each workflow step. eve keeps these concerns:

- session trace seeds, turn ID reservation, and trace policy;
- channel delivery metadata and principals;
- tool call locators and anchors that dispatched child agents read;
- direct `invokeTool` spans, which have no turn;
- SDK registration, request and MCP spans, and local trace storage.

eve's hook bridge maps AI SDK hooks to eve lifecycle events, not directly to
spans, so eve does not use `aiSdkTelemetry`.

## Validation

- Library tests use only package entrypoints. They cover a real
  `HarnessAgent`, `generateText`, an in-memory agent, delegation, streams, and
  durable recovery across workers.
- eve's span and telemetry contract suites pass without changes to their
  assertions.
- Live Agent Runs ingestion and fixture e2e run in CI only.

## Open questions

- Completions are one untyped object for every operation. Per-operation types,
  such as `model.complete(result)` with no `outcome`, would remove ambiguous
  fields.
- `lineage` and the in-process handoff describe delegation in two ways.
- Durable and non-durable modes close open tool calls differently.
- A turn cannot record its outcome without ending, so eve keeps the outcome
  until the session transition.
- Each checkpoint write serializes the open tree. Write volume needs watching
  on long tool-heavy turns.
