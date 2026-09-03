---
title: "Instrumentation Providers"
description: "Configure the experimental instrumentation provider layout, control captured inputs and outputs, and redact OpenTelemetry spans before export."
---

Instrumentation providers split observability into files under `agent/instrumentation/`. Each file can handle eve lifecycle events or add an OpenTelemetry destination without owning the rest of the telemetry pipeline.

**This API is experimental and may change without a deprecation period.** Enable it explicitly in `agent.ts`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-5",
  experimental: {
    instrumentationProviders: true,
  },
});
```

The provider directory replaces `agent/instrumentation.ts`; the two layouts cannot be used together. See [Observability](./instrumentation) for the default `instrumentation.ts` API.

## Add a provider

The filename identifies the provider slot. Each file must default-export `defineInstrumentation(...)`, an OpenTelemetry integration, or `disableInstrumentation()`.

```text
agent/instrumentation/
  audit.ts       lifecycle event provider
  braintrust.ts  OpenTelemetry destination
  otel.ts        process-wide OpenTelemetry settings
```

This provider records action timing and identity without receiving tool arguments or results:

```ts title="agent/instrumentation/audit.ts"
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  events: {
    "action.started": (event, ctx) => {
      ctx.state.set({ name: event.name, startedAt: Date.now() });
    },
    "action.completed": (event, ctx) => {
      const started = ctx.state.get() as { name: string; startedAt: number } | undefined;
      if (started === undefined) return;

      console.log({
        action: started.name,
        durationMs: Date.now() - started.startedAt,
        outcome: event.outcome,
      });
    },
  },
});
```

`ctx.state` is JSON storage scoped to this provider and operation. It survives durable suspension and is released after the terminal event.

## Control inputs and outputs

Each provider has an independent `tracePolicy`. It decides whether the provider receives events and whether those events include input or output content.

```ts title="agent/instrumentation/audit.ts"
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  tracePolicy: ({ audience }) => ({
    emit: true,
    recordInputs: audience === "public",
    recordOutputs: audience === "public",
  }),
  events: {
    "model.call.started": (event) => {
      console.log("input", event.input);
    },
    "model.call.completed": (event) => {
      console.log("output", event.content);
    },
  },
});
```

The policy receives `agentName`, `audience`, and, when available, `channelType`. `audience` is `"public"`, `"private"`, or `"unknown"`.

The default policy emits metadata for every audience and includes inputs and outputs only for `public` conversations. Return an explicit decision to change that behavior:

| Decision                                      | Result                                                       |
| --------------------------------------------- | ------------------------------------------------------------ |
| `false` or `{ emit: false }`                  | Do not invoke this provider for the trace.                   |
| `true`                                        | Emit the trace with the default audience-aware content rule. |
| `{ emit: true, recordInputs, recordOutputs }` | Emit the trace with the selected content directions.         |

Inputs include model prompts, tool arguments, channel input, and user responses. Outputs include model responses, tool results, requests for user input, provider metadata, and error details. Content fields are optional on event types because the active policy may remove them.

A provider's policy does not change another provider or the OpenTelemetry pipeline. A policy that throws fails closed for that provider.

## Redact fields in a custom provider

Lifecycle events are immutable snapshots. Copy the fields you need into a destination-specific payload and redact that copy before sending it:

```ts title="agent/instrumentation/audit.ts"
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  tracePolicy: () => ({
    emit: true,
    recordInputs: true,
    recordOutputs: false,
  }),
  events: {
    "action.started": async (event) => {
      await sendAuditRecord({
        id: event.idempotencyKey,
        input: redactApiKey(event.input),
        kind: event.kind,
        name: event.name,
      });
    },
  },
});

function redactApiKey(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;

  const record = value as Record<string, unknown>;
  return "apiKey" in record ? { ...record, apiKey: "[redacted]" } : record;
}

async function sendAuditRecord(record: unknown): Promise<void> {
  // Send the sanitized record to your provider.
  void record;
}
```

Prefer `recordInputs: false` or `recordOutputs: false` when the destination does not need an entire content direction. Use field-level redaction only when the destination needs part of that content.

## Add an OpenTelemetry destination

OpenTelemetry configuration has two parts:

- `otel()` declares process-wide settings such as the resource, sampler, propagators, and trace capture policy. Declare it at most once.
- `otelIntegration()` adds one destination. Declare one file per exporter or processor chain.

Most agents only need a destination:

```ts title="agent/instrumentation/braintrust.ts"
import { BraintrustExporter } from "@braintrust/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  traceExporter: new BraintrustExporter({ filterAISpans: true }),
});
```

Add `agent/instrumentation/otel.ts` when you need process-wide settings or want to control which content eve writes to OpenTelemetry spans:

```ts title="agent/instrumentation/otel.ts"
import { otel } from "eve/instrumentation/otel";

export default otel({
  resource: { "deployment.environment": process.env.VERCEL_ENV ?? "development" },
  tracePolicy: ({ audience }) => ({
    emit: true,
    recordInputs: audience === "public",
    recordOutputs: audience === "public",
  }),
});
```

The OpenTelemetry `tracePolicy` is a capture ceiling shared by its destinations. A destination cannot restore content excluded by this policy. It does not affect lifecycle event providers created with `defineInstrumentation()`.

## Redact managed OpenTelemetry destinations

`localTraces()` and `agentRuns()` accept an `exportPolicy`. Use the built-in redactors to remove known input or output attributes before that destination's processors receive a span:

```ts title="agent/instrumentation/agent-runs.ts"
import {
  agentRuns,
  composeSpanExportPolicies,
  redactSpanInputs,
  redactSpanOutputs,
} from "eve/instrumentation/otel";

export default agentRuns({
  exportPolicy: composeSpanExportPolicies(
    redactSpanInputs(({ audience }) => audience !== "public"),
    redactSpanOutputs(({ audience }) => audience !== "public"),
    {
      attribute: ({ key }) =>
        key === "user.email" ? { action: "replace", value: "[redacted]" } : { action: "keep" },
    },
  ),
});
```

`redactSpanInputs()` removes known prompts, instructions, documents, and tool arguments. `redactSpanOutputs()` removes known responses, reasoning, tool results, exception details, event attributes, and status messages. Their optional predicate receives the span name, IDs, attributes, and channel audience.

An export policy can also remove spans or attributes:

```ts
{
  span: ({ name }) => name !== "internal.cache.refresh",
  attribute: ({ key }) =>
    key === "customer.id" ? { action: "drop" } : { action: "keep" },
}
```

Policies run in declaration order. A later policy sees the filtered span produced by earlier policies. Redaction and filtering apply only to that destination and do not mutate spans shared with other destinations.

`recordInputs` and `recordOutputs` remain accepted by `localTraces()` and `agentRuns()` for compatibility, but are deprecated. Use `redactSpanInputs()` and `redactSpanOutputs()` in `exportPolicy` instead.

`otelIntegration()` does not accept `exportPolicy`. Use the process-wide `otel({ tracePolicy })` to limit capture for all custom OpenTelemetry destinations, or supply a destination-specific `SpanProcessor` that filters before its exporter.

## Built-in slots

The provider layout adds two environment-specific defaults:

- `local` records local traces during `eve dev`.
- `agent-runs` exports to Vercel Agent Runs in production.

Omitting these files preserves the defaults. Reconfigure a slot by exporting `localTraces()` or `agentRuns()` from the matching file. Disable one explicitly:

```ts title="agent/instrumentation/local.ts"
import { disableInstrumentation } from "eve/instrumentation";

export default disableInstrumentation();
```

## Lifecycle events

Providers can handle session, channel delivery, turn, model attempt, model call, action, input request, and tool call events. Start and terminal events share an `idempotencyKey`, which can serve as a destination row ID.

An ordinary tool emits both `action.*` and `tool.call.*` events. Use `action.*` for eve's durable dispatch lifecycle, including tools, skills, subagents, and remote agents. Use `tool.call.*` only when you need the AI SDK's in-process tool execution boundary.

Handlers for different providers run concurrently and are failure-isolated. Do not depend on provider execution order. Use `flush` to drain buffered records and `shutdown` to release resources.

## What to read next

- [Observability](./instrumentation): the default `instrumentation.ts` API and trace hierarchy
- [Local development](./dev-tui): inspect local traces in the TUI
- [Hooks](./hooks): react to runtime events outside the instrumentation provider API
