# Agent tracing library

This internal library records agent traces without an eve session or workflow.
It does not register an OTel provider. eve also uses its engine through the eve
span adapter, with the existing lifecycle bus and durable state.
The modules are not public package exports.

## Trace an AI SDK turn

Install an OTel provider and an async context manager in the application first.
Pass its tracer to `liveOtelBackend()`.

```ts
import { generateText } from "ai";
import { createAgentTracing } from "#tracing/core/index.js";
import { aiSdkTracing, aiSdkContentSerializer, liveOtelBackend } from "#tracing/adapters/index.js";

const tracing = createAgentTracing({
  agentName: "support",
  framework: { name: "custom-agent", version: "1.0" },
  backend: liveOtelBackend(tracer),
  serializer: aiSdkContentSerializer,
});

await tracing.turn({ conversationId, runId, turnId, sequence: 0 }, async (turn) => {
  return await generateText({ model, messages, tools, telemetry: aiSdkTracing(turn) });
});
```

Each turn starts a new root. The SDK adapter creates steps, model calls, actions,
and tool executions. SDK retries have separate model spans. Turn usage counts
completed physical model calls once. Content capture is off by default.

Consume a streaming response inside the turn callback. Do not return an unconsumed
stream or start detached work. Other SDK calls can use the same turn. Each call
gets independent correlation state and unique step indices.

Pass unrelated SDK integrations through `aiSdkTracing(turn, { integrations })`.
Do not supply another integration that records the same model and tool spans.

## Instrument other operations

`createAgentOperations()` provides steps, models, actions, tools, approvals, and
memory operations. Framework adapters supply operation IDs, explicit parents,
and terminal outcomes. `operation.run()` activates its async context.
Call `turn.own(operation)` when the turn must close an operation on exit.

`createTransportTracing()` records request and MCP fallback spans separately.
Request route inputs must be registered templates, not user-supplied URLs.
Annotate an existing tool through `operations.engine.annotate()` instead of
creating an MCP fallback when the tool already owns the execution.

`createTraceEngine()` accepts prepared span attributes and supports output types
from the design contract. Use this lower-level interface for framework events.
It filters known content attributes before backend creation and late updates.
Instrumentation failure does not retry application execution.

## Durable execution

`durableOtelBackend()` requires the supplied ID generator to be installed in the
host tracer provider. The caller supplies the root sampling function.
`createDurableTraceDriver()` stores portable span records through a caller-owned
store. Reserve a record before dispatch. Finish the record in the worker that
accepts the terminal result.

The caller must serialize operations on the same key. The store is not a lock or
a transaction coordinator. Export deduplication remains the caller's responsibility.
Persist only permitted content. Do not persist application errors in a span record.

## Output compatibility

The default contract uses schema version 1 and no `eve.*` or platform keys.
Pass `eveOutputMapping()` to the OTel backend to select existing eve schema keys.
Its optional resolver supplies Vercel trace-session attribution by operation ID.
The mapping also applies to late attribute updates and durable sampling input.

Other output mappings can override names, metadata attributes, and links.
Do not rename content attributes without a matching destination redaction policy.
Apply destination policies after the backend mapping. No mapping changes topology.

eve installs the compatibility mapping for its framework spans.
Agent Runs export, deployment configuration, and remote protocol handling remain
outside this library.
