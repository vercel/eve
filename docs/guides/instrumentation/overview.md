---
title: "Instrumentation"
description: "Trace an agent with OpenTelemetry in instrumentation.ts, read the workflow run tags eve emits, and debug discovery with eve info and the common-failures table."
url: "/observability/instrumentation"
---

Use `agent/instrumentation.ts` to configure OpenTelemetry for an eve agent.
eve discovers this file and runs it at server startup before agent code.

## Configure OpenTelemetry

Export `defineInstrumentation(...)` as the default export from
`agent/instrumentation.ts`. eve discovers the file and runs its `setup`
callback at server startup, before agent code runs.

```ts title="agent/instrumentation.ts"
import { BraintrustExporter } from "@braintrust/otel";
import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new BraintrustExporter({
        parent: `project_name:${agentName}`,
        filterAISpans: true,
      }),
    }),
});
```

Use `setup` to register your OTel provider. eve supplies the resolved agent
name, so you do not need to hard-code a service name. Any OTel-compatible
backend works; install and configure the exporter it requires.

eve records metadata without model, tool, or memory-record content by default.
After reviewing the exporter's destination and retention path, opt in to the
content you need:

- `recordInputs` records message history and recalled memory records. It
  defaults to `false`.
- `recordOutputs` records model outputs. It defaults to `false`.
- `functionId` overrides the function name on spans. It defaults to the agent
  name.

The session's channel audience is a second gate on content capture. In
Vercel's preview and production deployments, eve records inputs and outputs
only for `public` sessions. During local development, local tracing retains all
content. See [Local traces](#local-traces) to learn more.

For the default eve HTTP channel, the audience is:

| Session creator                                      | Audience  |
| ---------------------------------------------------- | --------- |
| Anonymous caller                                     | `unknown` |
| Authenticated `user`, `service`, or `runtime` caller | `private` |
| Any other principal type                             | `unknown` |

Set `audience: "public"` only for intentionally public traffic. Other
built-in channels classify their own conversations. See
[Audience](../channels/eve#audience) for the `eve` channel or
[Conversation audience](../channels/custom#conversation-audience) for a
custom channel.

## Add runtime context

Use `events["step.started"]` to add values to the AI SDK runtime context for a
model attempt. The AI SDK carries the returned values onto the model-call span
and its children.

```ts title="agent/instrumentation.ts"
import { defineInstrumentation, isChannel } from "eve/instrumentation";
import supportChannel from "./channels/support";

export default defineInstrumentation({
  events: {
    "step.started"(input) {
      if (!isChannel(input.channel, supportChannel)) return undefined;

      return {
        runtimeContext: {
          "support.channel_id": input.channel.metadata.channelId ?? "",
          "support.user_id": input.channel.metadata.triggeringUserId ?? "",
        },
      };
    },
  },
});
```

The callback receives the session, turn, step, channel, and final model input.
For an authored channel, import its definition and use `isChannel` before
accessing its typed metadata. Runtime instrumentation receives only the
metadata a channel explicitly exposes; it never falls back to raw channel
state.

## Trace topology

When `agent/instrumentation.ts` registers an OTel provider, each turn produces
this hierarchy:

```text
ai.eve.turn  {eve.session.id}
  +-- invoke_agent <model>                    gen_ai.operation.name=invoke_agent
        +-- step 1                            gen_ai.operation.name=agent_step
        |     +-- chat <model>                gen_ai.operation.name=chat
        |     +-- execute_tool search         gen_ai.operation.name=execute_tool
        +-- step 2
        |     +-- chat <model>
        |     +-- execute_tool read
        +-- step 3 (final text)
              +-- chat <model>
```

eve creates the `ai.eve.turn` parent span and passes telemetry to the
[AI SDK](https://ai-sdk.dev/docs/ai-sdk-core/telemetry), which traces model
calls and tool executions. The AI SDK names those spans according to the
OpenTelemetry GenAI semantic conventions.

Set `traceChannelRequests: true` to create one OTel `SERVER` span for each
inbound channel HTTP request. The span parents the turn tree and any
`hook.resume` or outgoing HTTP spans. It defaults to `false`.

```text
POST /eve/v1/session/:sessionId
  └── hook.resume
        ├── GET hooks/by-token
        └── POST hook_received
```

The request span uses a route template in `http.route` and the method in
`http.request.method`; it does not record concrete URLs, session IDs, tokens,
headers, bodies, or query parameters. It adopts an incoming `traceparent` when
present.

## Local traces

Without `agent/instrumentation.ts`, `eve dev` records one bounded trace per
turn under `.eve/traces/`. View traces with
[`/traces`](../guides/dev-tui#logs-and-traces) in the dev TUI or
[`eve traces`](../reference/cli#eve-traces) after `eve dev` exits.

Local traces retain model, tool, and memory-record content by default. Set
`EVE_TRACES_CONTENT=off` in `.env.local` to omit it. Writing
`agent/instrumentation.ts` replaces local tracing; its `recordInputs` and
`recordOutputs` settings control content in the OTel provider you register.

## Workflow run tags

Separately from OpenTelemetry, eve tags every Workflow run with reserved
`$eve.*` attributes. These framework-owned attributes are queryable in the
Workflow dashboard, not on OTel spans. eve emits them for every session, turn,
and subagent run, whether or not `agent/instrumentation.ts` exists.

Structural tags describe a run's place in its tree:

- `$eve.type`: `"session"`, `"turn"`, or `"subagent"`.
- `$eve.parent`: the immediate parent session ID.
- `$eve.root`: the root session ID for the tree.
- `$eve.subagent`: the compiled graph node ID for a subagent run.
- `$eve.trigger`: the channel kind that started the run.
- `$eve.schedule`: the schedule that created the session.
- `$eve.title`: a truncated title from the first user message.
- `$eve.trace_id`: a sampled trace seed. Use it as a trace link, not a
  conversation-wide identity.

Each turn also accumulates `$eve.model`, `$eve.input_tokens`,
`$eve.output_tokens`, `$eve.cache_read_tokens`, and `$eve.tool_count`. These
tags power the **Agent Runs** tab in Vercel's **Observability** view. See
[Deploy to Vercel](../guides/deployment/vercel#inspect-agent-runs) for
enablement.

## Debug discovery

Run `eve info` to see the instrumentation eve discovered and any diagnostics.
eve also writes these inspectable artifacts under `.eve/`:

| Artifact                        | Tells you                           |
| ------------------------------- | ----------------------------------- |
| `agent-discovery-manifest.json` | What eve found on disk.             |
| `diagnostics.json`              | Authored-shape errors and warnings. |
| `compiled-agent-manifest.json`  | The surface eve loads at runtime.   |
| `module-map.mjs`                | Compiled module entry points.       |

### Common failures

| Symptom                               | Next action                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Instrumentation is not discovered.    | Run `eve info`, confirm the file is in the expected slot, and read `.eve/diagnostics.json`.       |
| A tool is not discovered.             | Confirm it is under `agent/tools/`, default-exports `defineTool(...)`, and appears in `eve info`. |
| `eve build` reports discovery errors. | Read the printed diagnostics and `.eve/diagnostics.json`.                                         |

## Instrumentation Providers

[Instrumentation Providers](./instrumentation-providers) is an experimental
multi-file alternative. It cannot be used with `agent/instrumentation.ts`.
Use it when you need independent lifecycle-event providers, OpenTelemetry
destinations, directional content capture, or per-destination redaction.
