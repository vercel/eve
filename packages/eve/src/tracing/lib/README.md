# Agent tracing

`@vercel/agent-tracing` records agent execution with OpenTelemetry. It owns
span topology, capture, completion, and durable checkpoints. The source package
is private; it is not yet published to npm. Its only runtime package dependency
is `@opentelemetry/api`.

## Setup

Pass a telemetry object that writes spans and tracks the active trace context.
`otelTelemetry()` adapts an OpenTelemetry tracer provider; it does not register
global telemetry or install another model SDK tracing pipeline.

```ts
import { createAgentTracing, otelTelemetry } from "@vercel/agent-tracing";

const tracing = createAgentTracing({ telemetry: otelTelemetry({ provider }) });
```

Omit `telemetry` to use the global provider. Your provider owns exporters,
sampling, and context propagation. Install its context manager before
concurrent work. `forceFlush()` and `shutdown()` call the telemetry's lifecycle
methods, which default to the provider's. Other backends implement
`AgentTelemetry` directly.

## Wrapped execution

Wrapped methods preserve the callback's value or error and complete their span.

```ts
await tracing.turn({ agentName: "support", identity, sequence: 0 }, (turn) =>
  turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
    attempt.tool({ callId: "lookup", name: "lookup" }, lookup),
  ),
);
```

`identity` contains `conversationId`, `runId`, and `turnId`. `agentName` names the
invocation span, so one instance can trace several agents. A turn can supply
framework metadata, attributes, and a capture decision. Capture defaults to
metadata only. Child operations cannot increase capture.

Attempts provide `tool`, `callSubAgent`, and `callRemoteAgent`; each tool call is
one `execute_tool` span. Tools provide `approval` and nested `tool` calls. Turns,
attempts, and tools provide `memory`.
Use `describe(value)` to map a callback result to an outcome or captured output.

## Handles

Omit the callback when execution starts and ends in different hooks.

```ts
const turn = await tracing.turn({ identity, sequence: 0 });
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

Handles expose execution, attributes, completion, and identity.
`run(execute, ceiling)` limits captured content for work inside the run without
changing what the operation already recorded. Content any operation receives
while the run is active, such as an existing tool's arguments, result, or error,
is held to that ceiling. Re-entering a durable turn with a narrower `capture`
narrows the turn and its open operations and drops retained content the new
decision declines. `recordError(error)` records a
failure without ending the operation, for example when a tool's work fails in a
process that does not finish its span; a completion reported later stays
failed. Parent
completion closes unfinished children; in durable turns, a successful attempt
or turn leaves open tool calls and approvals for their own completion.
`complete()` is idempotent.

A host can learn about one call twice, for example when the SDK runs a tool
before the runtime records its dispatch. In a durable turn, calling
`attempt.tool()` again with the same `callId` returns the same call. It fills in
`kind` and `arguments` the first call lacked and keeps the earlier
`startTimeMs`.

## Model calls and streams

`modelCall(data, execute)` accepts an envelope with `result`, `finishReason`,
`usage`, and optional response/content metadata. It returns only `result`.
Without a callback, `modelCall(data)` returns a model handle.

```ts
const stream = await attempt.modelStream({ provider: "test", modelId: "model" }, () => ({
  result: response.stream,
  completion: response.completion,
}));
```

The completion promise supplies finish reason, usage, and optional content. It
must settle on success, failure, or cancellation. The library returns the stream
unchanged and never consumes it. Parent completion waits for that promise.

## AI SDK

`aiSdkTelemetry` is an AI SDK telemetry integration. It records each
`generateText`, `streamText`, or agent call as a turn, with its steps, model
calls, and tool executions, and runs model calls and tools inside their spans.

```ts
import { aiSdkTelemetry } from "@vercel/agent-tracing/ai-sdk";

await generateText({
  model,
  prompt,
  telemetry: {
    integrations: [
      aiSdkTelemetry(tracing, { turn: { agentName: "support", identity, sequence: 0 } }),
    ],
  },
});
```

Pass a function as `turn` to choose the turn per call. `modelUsage` and
`modelContent` convert AI SDK payloads for hosts that record model calls
themselves. The entrypoint has an optional peer dependency on `ai`.

## Delegation

Local delegation carries lineage across asynchronous calls. A local callee's first
turn nests under the delegating tool call, and later turns start their own trace.
A remote callee starts its own trace with an `agent.dispatch` link to the call.
Remote calls need an explicit sender transport and authenticated receiver trust
check.

```ts
import { createAgentDelegationTransport } from "@vercel/agent-tracing/delegation";
const transport = createAgentDelegationTransport();
const fetchAgent = transport.transport(approvedAgentFetch);
await attempt.callRemoteAgent({ callId: "remote", agentName: "research" }, () =>
  fetchAgent(approvedAgentUrl),
);

transport.receive(request.headers, verifyAuthenticatedCaller, () =>
  tracing.turn({ identity, sequence: 0 }, runAgent),
);
```

Bind the sender only to approved destinations. It rejects redirects. The receiver
validates the bounded `x-agent-tracing` header before calling your trust callback.
Metadata is not authorization: verify authenticated provenance and the expected
caller, parent run, and call. Rejected metadata does not change application work.

## Durable turns

Pass a checkpointer when a turn can outlive the process that started it, for
example across workflow steps. Durable spans need stable IDs, so install an
`AgentSpanIdGenerator` on the provider and give it to the telemetry.

```ts
const idGenerator = new AgentSpanIdGenerator();
const provider = new BasicTracerProvider({ idGenerator, spanProcessors });
const tracing = createAgentTracing({
  telemetry: otelTelemetry({ provider, idGenerator }),
  checkpointer: { get, set, delete: remove },
});
```

Resume by calling the same operations with the same identifiers. The library
continues the saved turn instead of starting a new one:

```ts
const turn = await tracing.turn({ identity, sequence: 0 });
const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
const tool = await attempt.tool({ callId: "lookup", name: "lookup" });
const approval = await tool.approval({ requestId: "approval" });
await approval.complete({ outcome: "approved" });
```

Turns are keyed by `runId` and `turnId`; attempts by step index
and attempt; tool calls by `callId`; approvals by `requestId`. Model calls and
memory finish within one process and are not resumed. `tracing.resume({ identity })`
returns a saved turn without starting one, for example to finish a tool call
after its turn has completed. `turn.findTool(callId)`, `turn.findAttempt()`, and
`tool.findApproval()` return open operations, or `undefined` once they have
finished:

```ts
const tool = (await tracing.resume({ identity }))?.findTool("lookup");
await tool?.complete({ outcome: "completed" });
```

A turn can adopt a trace and span ID reserved before it started, such as one
already returned to a caller, with `reference`. The telemetry's sampler still
decides whether a root turn is recorded. `parent` nests a turn under a caller's
span instead. `lineage`, `channel`, `links`, and
`startTimeMs` describe host-owned delegation and delivery; `turn.links()`
replaces links learned after the turn started.

The library writes JSON after each change and deletes the entry when the turn
and its open tool calls complete. Back the checkpointer with storage that commits alongside your
workflow step. An unreadable checkpoint is reported to `onError` and the turn
starts fresh. Durable turns, tool calls, and approvals are exported when they
complete, so their spans carry the IDs their children already reference.

## OpenTelemetry plumbing

`@vercel/agent-tracing/otel` exports helpers for hosts that run their own spans
beside agent tracing: the active operation, capture context, content bounds,
and MCP enrichment. Agent tracing itself needs only the package root.

## Privacy and failures

Declined content does not enter checkpoints. Failure classes survive redaction;
exception content does not. Serialized content is capped at 32 KiB, each checkpointed
operation at 64 KiB, and unfinished children at 10,000. `onError(error, context)` is the only
tracing error channel. Trace output retains schema version 4.

Local tests cover output and recovery. They do not prove live Agent Runs ingestion.
