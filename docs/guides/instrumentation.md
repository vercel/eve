---
title: "instrumentation.ts"
description: "Trace an agent with OpenTelemetry in instrumentation.ts, read the workflow run tags eve emits, and debug discovery with eve info and the common-failures table."
---

`instrumentation.ts` is where you configure how an eve agent is observed. The framework auto-discovers `agent/instrumentation.ts` and runs it at server startup before any agent code. Its presence implicitly enables telemetry, so there is no separate `isEnabled` toggle.

If you intend to export telemetry, review the exporter destination, data categories, and required legal approvals before enabling telemetry.

## Three observability surfaces

eve observes an agent through three distinct surfaces. They do not all live in this file, and they write to different places:

| Surface                          | Configured in `instrumentation.ts`?                         | What it is                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow run tags** (`$eve.*`) | No (automatic)                                              | Framework-owned attributes on each Vercel Workflow run. Let dashboards stitch session, turn, and subagent runs into a tree and surface model and token usage. |
| **OpenTelemetry export**         | Yes: `setup`, `recordInputs`, `recordOutputs`, `functionId` | Where AI SDK spans are exported and what they record.                                                                                                         |
| **Runtime context events**       | Yes: `events["step.started"]`                               | Per-model-call values written into the AI SDK's runtime context, which the AI SDK carries onto its spans.                                                     |

The two configurable surfaces send AI SDK spans to your OpenTelemetry backend. Workflow run tags are a separate system, queryable in the Workflow dashboard rather than on your OTel spans. The sections below cover what you configure here; [Workflow run tags](#workflow-run-tags) documents what eve emits on its own.

## Define instrumentation

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

Export the result of `defineInstrumentation` as the default export.

## OpenTelemetry

Use the `setup` callback to register your OTel provider (for example `registerOTel` from `@vercel/otel`). The framework invokes it at server startup with the resolved agent name. `context.agentName` is resolved at compile time from your project (the package's `name`, falling back to the app directory name), so you never hard-code a service name.

Any OTel-compatible backend works (Braintrust, Raindrop, Arize, Honeycomb, Datadog, Jaeger). Install the exporter package you need and configure it in the callback.

Three more fields control what the AI SDK records inside those spans (see the AI SDK's [telemetry reference](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)):

- `recordInputs` records full message history on each step span (defaults to `true`). Set it to `false` if inputs contain sensitive content or you want to reduce span payload size.
- `recordOutputs` records model outputs on spans (defaults to `true`). Set it to `false` to disable output recording.
- `functionId` overrides the function name on spans (defaults to the agent name).

For sensitive, regulated, or production data, set `recordInputs` and `recordOutputs` to `false` unless you have reviewed the exporter and its data-retention path.

You are responsible for ensuring any observability or eval provider is approved for the data exported to it.

The third configurable surface, [runtime context events](#runtime-context), attaches per-model-call values to these spans.

## Runtime context

_Runtime context_ is an [AI SDK concept](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text): a user-defined object that flows through a generation lifecycle. eve exposes it through `events["step.started"]`, a callback that runs once eve has assembled the model input for an attempt and returns `{ runtimeContext }`. Because eve registers the AI SDK's OpenTelemetry integration with runtime context enabled, those returned values ride onto the model-call span and its children. The field is named `runtimeContext`, not `metadata`, because AI SDK v7 carries per-call attributes on runtime context rather than a dedicated metadata field.

Use it when the values depend on the current session, turn, step, channel, or model input:

```ts
import { defineInstrumentation, isChannel } from "eve/instrumentation";
import supportChannel from "./channels/support";

export default defineInstrumentation({
  events: {
    "step.started"(input) {
      if (!isChannel(input.channel, supportChannel)) {
        return undefined;
      }

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

The callback receives:

- `session`: the session id, current and initiator auth, and parent session lineage when this is a child run
- `turn`: the stream turn id and sequence, for example `turn_0`
- `step`: the zero-based step index inside the turn
- `channel`: the channel's `kind` and the metadata projected by the active channel
- `modelInput`: the final instructions and messages passed to the model call

A channel exposes its identity through `kind`. For authored channels it is `channel:<name>`, where `<name>` is the channel's filename under `agent/channels/`, so `agent/channels/support.ts` is `channel:support`. Framework channels use `http`, `schedule`, or `subagent`, and an unrecognized or absent kind normalizes to `unknown`. The kind is also emitted as the `eve.channel.kind` span attribute. To access an authored channel's metadata with its precise type, import the channel definition and narrow with `isChannel(input.channel, supportChannel)`.

Channel metadata is channel-owned. Built-in channels expose only the fields they choose to make observable; Slack, for example, projects `channelId`, `teamId`, `threadTs`, and `triggeringUserId` from its durable channel state. User-authored channels expose their own projection by returning `metadata(state)` from `defineChannel`. Runtime instrumentation never falls back to raw channel state.

## Trace hierarchy

When telemetry is enabled, each turn produces a trace like:

```text
ai.eve.turn  {eve.session.id}
  +-- ai.streamText                           step 1
  |     +-- ai.streamText.doStream            model call
  |     +-- ai.toolCall  {toolName: search}   tool exec
  +-- ai.streamText                           step 2
  |     +-- ai.streamText.doStream
  |     +-- ai.toolCall  {toolName: read}
  +-- ai.streamText                           step 3 (final text)
```

eve creates the `ai.eve.turn` parent span per turn and passes enriched telemetry to the AI SDK so model calls and tool executions are traced automatically. Session, turn, step, and channel context is injected as the framework half of the runtime context (`eve.version`, `eve.session.id`, `eve.environment`, `eve.turn.id`, `eve.turn.sequence`, `eve.step.index`, `eve.channel.kind`) and rides onto the spans alongside any values your `events["step.started"]` callback returns under `runtimeContext`.

## Workflow run tags

Separately from OpenTelemetry, eve tags every workflow run with reserved `$eve.*` attributes. These live on the Vercel Workflow run, queryable in the Workflow dashboard, not on OTel spans, and you do not configure them: they are framework-owned and emitted automatically on every session, turn, and subagent run, whether or not an `instrumentation.ts` file is present. Authored code cannot set or override the `$eve.` namespace.

They let a dashboard reconstruct the tree of runs behind a single agent invocation and surface model and token usage without reading run bodies.

Structural tags describe each run's place in the tree:

- `$eve.type`: `"session"`, `"turn"`, or `"subagent"`
- `$eve.parent`: session id of the immediate parent
- `$eve.root`: session id of the root session in the chain (group a whole tree with `$eve.root=<id>`)
- `$eve.subagent`: compiled graph node id (subagent runs only)
- `$eve.trigger`: the channel kind that started the run
- `$eve.title`: truncated title derived from the first user message

Per-turn usage tags are written on each step of a turn, accumulating cumulative totals (last write wins):

- `$eve.model`: model id for the turn
- `$eve.input_tokens`, `$eve.output_tokens`, `$eve.cache_read_tokens`: running token counts
- `$eve.tool_count`: number of tools available to the turn

Tag writes are best-effort: a failure is logged once per process and then swallowed, so a broken tag emit never breaks the agent.

These tags power the **Agent Runs** tab in the Vercel dashboard. When you deploy on Vercel, the platform auto-detects `eve` as the framework and surfaces an Agent Runs view under your project's **Observability** tab, where you can browse sessions and drill into each conversation's trace, with no `instrumentation.ts` required. The tab is currently gated per team. See [Deploy to Vercel](./deployment/vercel#inspect-agent-runs) for enablement. Agent Runs is separate from the OpenTelemetry export above. Use OTel when you want spans in Braintrust, Datadog, or another third-party backend.

Note: By default, telemetry records full message history and model outputs You may need to disclose these data flows in your privacy materials if utilized.

## Debugging

`eve info` is the fastest way to see what eve actually picked up: the active tools, skills, subagents, schedules, routes, and discovery diagnostics. eve also writes inspectable artifacts under `.eve/`, kept even when discovery hits errors:

| Artifact                        | Tells you                                   |
| ------------------------------- | ------------------------------------------- |
| `agent-discovery-manifest.json` | what eve found on disk                      |
| `diagnostics.json`              | authored-shape errors and warnings          |
| `compiled-agent-manifest.json`  | the serialized surface eve loads at runtime |
| `module-map.mjs`                | compiled module entrypoints eve imports     |

When `eve build` fails on discovery errors, the CLI prints the full diagnostics report (severity, message, source path) and the path to the diagnostics artifact.

### Common failures

| Symptom                                       | Likely cause and fix                                                                                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool not discovered (the model never sees it) | Run `eve info`. Confirm the file is in the right slot (`agent/tools/<name>.ts`) and default-exports `defineTool(...)`, and check `.eve/diagnostics.json` for shape errors. `schedules/` are root-only.                                                                      |
| Model won't call a tool it should             | Tighten the tool `description` and `inputSchema`; put procedural guidance in a [skill](../skills), not the description. Confirm it's in the active set with `eve info`.                                                                                                     |
| Stuck on `session.waiting`                    | The turn is parked on an approval, a question, or a connection sign-in. Answer it, or POST a follow-up with the `continuationToken` (a stale token is rejected).                                                                                                            |
| 401 on production routes                      | Expected: auth fails closed. Replace `placeholderAuth()` with your route policy. Use `vercelOidc()` only for Vercel-issued tokens; otherwise configure `httpBasic()`, JWT/OIDC helpers, or a custom `AuthFn`. See [Auth and route protection](./auth-and-route-protection). |
| Build fails with discovery errors             | Read the printed diagnostics and `.eve/diagnostics.json`; confirm the root-vs-subagent boundary is valid and secrets come from env vars.                                                                                                                                    |

## What to read next

- [`agent.ts`](../agent-config)
- [Hooks](./hooks): observe the runtime event stream
- [Local Development](./dev-tui): drive the agent locally
- [Evals](../evals/overview): repeatable scored checks
