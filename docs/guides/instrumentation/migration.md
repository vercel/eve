---
title: "Migrate Instrumentation"
description: "Move a single instrumentation.ts configuration into lifecycle instrumentation and OpenTelemetry destinations."
url: "/observability/instrumentation-migration"
---

Replace `agent/instrumentation.ts` with path-named files under
`agent/instrumentation/`. Remove
`experimental.instrumentationProviders` from `agent.ts`; instrumentation
discovery is now always enabled.

## Preserve metadata-only capture

In the removed API, omitted `recordInputs` and `recordOutputs` settings both
defaulted to `false`. Once an OpenTelemetry destination is present, the new
default includes content during development and for public conversations.

Add `agent/instrumentation/otel.ts` with an explicit metadata-only policy
before moving exporters:

```ts title="agent/instrumentation/otel.ts"
import { otel } from "eve/instrumentation/otel";

export default otel({
  functionId: "support-agent",
  traceChannelRequests: true,
  tracePolicy: () => ({
    emit: true,
    recordInputs: false,
    recordOutputs: false,
  }),
});
```

After verifying each destination's retention and access controls, widen
`recordInputs` or `recordOutputs` deliberately if needed.

## Move an OpenTelemetry exporter

Move each exporter into its own destination file and replace startup
`registerOTel(...)` calls with `otelIntegration(...)`. Install `@vercel/otel`
if the exporter comes from that package:

```bash
pnpm add @vercel/otel
```

```ts title="agent/instrumentation/honeycomb.ts"
import { OTLPHttpProtoTraceExporter } from "@vercel/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  exportPolicy: {
    span: () => ({ redact: true, inputs: true, outputs: true }),
  },
  traceExporter: new OTLPHttpProtoTraceExporter({
    url: "https://api.honeycomb.io/v1/traces",
    headers: {
      "x-honeycomb-team": process.env.HONEYCOMB_API_KEY!,
    },
  }),
});
```

The destination policy preserves metadata-only export even if the shared
OpenTelemetry policy is widened later. Add another file for each additional
destination; eve combines them into one pipeline.

## Move runtime context and lifecycle events

Use this mapping when splitting the old definition:

| `agent/instrumentation.ts` field | New location                                 |
| -------------------------------- | -------------------------------------------- |
| `setup` with `registerOTel`      | One `otelIntegration()` file per destination |
| `functionId`                     | `otel({ functionId })`                       |
| `recordInputs`, `recordOutputs`  | `otel({ tracePolicy })`                      |
| `traceChannelRequests`           | `otel({ traceChannelRequests })`             |
| `events["step.started"]`         | `otelIntegration({ runtimeContext })`        |

Move `events["step.started"]` to the destination that needs those attributes;
see [Add runtime context](/docs/observability/otel#add-runtime-context). For
eve lifecycle events, create a separate file with `defineInstrumentation(...)`;
see
[Instrumentation](/docs/observability/instrumentation).

## Verify the migration

Run `eve build`. A remaining `agent/instrumentation.ts` fails the build with a
message directing you to the instrumentation directory.

New eve deployments automatically sample 100% of requests. Existing Vercel
deployments need project sampling configured before you verify them. See
[Enable tracing on Vercel](/docs/observability/otel#enable-tracing-on-vercel).

Then run the agent and verify each destination independently.
