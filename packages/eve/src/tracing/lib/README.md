# Durable agent tracing

This internal module owns agent span identity, capture, completion, and durable
snapshots. eve is its only production consumer. It is not a published package or
a general agent-authoring API.

## Ownership

The recorder returns one operation handle for each span. Its kind determines
parent rules, attributes, redaction, and completion. A pending tool uses the same
handle with a parent that attaches later.

eve owns OpenTelemetry registration, exporters, AI SDK conversion, requests,
MCP transport, remote trust, and workflow storage. Those adapters stay outside
this module. The module accepts a backend and serializer, not an OTel provider.

## Start and finish operations

```ts
const tracing = createTraceRecorder({ output: backend, serializer });
const turn = await tracing.turn({
  identity: { conversationId, runId, turnId, framework: { name: "eve", version } },
  operationId: turnId,
  capture: { emit: true, recordInputs: false, recordOutputs: false },
  metadata: { sequence: 0 },
});

const snapshot = turn.snapshot();
// Store snapshot directly in the host's existing transaction.
const resumed = await tracing.resume(snapshot);
await resumed?.complete();
```

`snapshot()` returns an opaque, branded JSON value. The host does not construct
or edit a scope record. `checkpoint(snapshot, { usage, terminal })` adds durable
usage or an outcome without emitting the span. `resume()` validates stored
state and can narrow capture. Invalid state affects only that operation.

`run(execute)` installs context and preserves the application's result or error.
`complete(result)` emits once. `fail(error)` records a failed outcome. Attempt
handles create physical model-call handles with `modelCall(data, key)`.

Turns, actions, and approvals defer emission until completion. Attempts and
model calls are live. Parent completion abandons unfinished children. Replay
keeps durable boundary IDs but creates fresh physical model-call IDs.

## Pending tools

`pendingTool(data)` reserves a tool handle before the action exists. Store its
snapshot like any operation. `resumeTool(snapshot)` restores it;
`attach(parentReference)` supplies the action parent. Completion can arrive
before attachment. `drain()` closes unresolved work against its fallback parent.
MCP enrichment remains on the same tool span.

## Capture and bounds

Capture can decrease but cannot increase. Declined inputs and outputs do not
enter snapshots. Failure classes survive redaction; exception content does not.
Serialized content is bounded to 32 KiB, snapshots to 64 KiB, and unfinished
children to 10,000. Snapshot validation bounds recursion and checks identities.
`onError(error, context)` observes tracing failures without interrupting work.

Trace output retains schema version 4. Local exporter tests protect topology
and recovery, but do not prove live Agent Runs ingestion.
