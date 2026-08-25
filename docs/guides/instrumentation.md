---
title: "Observability"
description: "Trace an agent with OpenTelemetry in instrumentation.ts, read the workflow run tags eve emits, and debug discovery with eve info and the common-failures table."
---

`instrumentation.ts` is where you configure how an eve agent is observed. The framework auto-discovers `agent/instrumentation.ts` and runs it at server startup before any agent code. Its presence implicitly enables telemetry, so there is no separate `isEnabled` toggle.

If you intend to export telemetry, review the exporter destination, data categories, and required legal approvals before enabling telemetry.

## Three observability surfaces

eve observes an agent through three distinct surfaces. They do not all live in this file, and they write to different places:

| Surface                          | Configured in `instrumentation.ts`?                      | What it is                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow run tags** (`$eve.*`) | No (automatic)                                           | Framework-owned attributes on each Vercel Workflow run. Let dashboards stitch session, turn, and subagent runs into a tree and surface model and token usage. |
| **OpenTelemetry export**         | Local: automatic. Authored: `setup` and capture settings | Where agent and AI spans are exported and what they record.                                                                                                   |
| **Runtime context events**       | Yes: `events["step.started"]`                            | Per-model-call values written into the AI SDK's runtime context, which the AI SDK carries onto its spans.                                                     |

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

Any OTel-compatible backend works (Braintrust, PostHog, Raindrop, Arize, Honeycomb, Datadog, Jaeger). Install the exporter package you need and configure it in the callback. The [PostHog AI Observability integration](/integrations/posthog-instrumentation) provides a ready-to-install exporter and optional user identification.

Three more fields control what the AI SDK records inside those spans (see the AI SDK's [telemetry reference](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)):

- `recordInputs` records full message history on each step span. It defaults to `false`; set it to `true` to include input content.
- `recordOutputs` records model outputs on spans. It defaults to `false`; set it to `true` to include output content.
- `functionId` overrides the function name on spans (defaults to the agent name).

eve records metadata without model or tool inputs and outputs by default. Enable either content category only after reviewing the exporter and its data-retention path.

You are responsible for ensuring any observability or eval provider is approved for the data exported to it.

The third configurable surface, [runtime context events](#runtime-context), attaches per-model-call values to these spans.

Built-in messaging channels classify their instrumentation metadata with an `audience`: `public`, `private`, or `unknown`. Slack public channels and Chat SDK workspace-visible threads are public; direct and private conversations are private; platform surfaces without enough visibility evidence remain unknown.

## Four instrumentation decisions

eve keeps four decisions separate so one observability destination cannot change another:

1. **Session trace admission** decides whether eve creates a native `agent.*` trace. `tracePolicy` runs once when the session is created. Local subagents inherit the parent decision. A remote agent accepts a propagated sampled decision only when its own local policy also admits the session.
2. **Provider producer capture** decides whether eve builds content-bearing lifecycle events and AI SDK telemetry. The session freezes the union of content requested by authored providers, an admitted native trace, and legacy `recordInputs` or `recordOutputs` settings. Rejecting an OTel trace does not disable an independent authored content provider.
3. **Workflow content visibility** controls `$eve.is_trace_content_visible` and content-derived workflow attributes. It follows the existing audience rule and freezes when the session is created. This flag is separate from provider capture.
4. **Per-destination span export policy** filters the admitted span immediately before one destination's processor chain. Each destination receives its own facade; filtering does not mutate the shared span or another destination's view.

An admitted private or unknown trace captures complete source content before destination filtering. Add `redactSpanInputs()` and `redactSpanOutputs()` to every destination that must not receive that content.

When you use the instrumentation provider layout, `otel({ tracePolicy, sampler })` applies these boundaries explicitly. `tracePolicy` is authoritative for native `agent.*` traces and their AI SDK descendants. `sampler` still controls unrelated authored, request, and auto-instrumented roots, but it cannot overturn a native session decision. The process sampler continues to preserve an incoming unsampled remote parent.

## Channel delivery traces

Instrumentation providers receive `channel.delivery.started` followed by
`channel.delivery.completed`, `channel.delivery.cancelled`, or
`channel.delivery.failed` for every inbound channel operation. The lifecycle
covers durable processing through the terminal state of the resulting turn, not
messages an adapter sends back to Slack, Telegram, Twilio, or another platform.
Several deliveries can coalesce into one turn while retaining separate lifecycle
pairs, and an adapter can consume a delivery without starting a turn.

Each operation has a framework-owned `deliveryId` distinct from its optional
platform request ID. Metadata-only providers receive identity, channel, session,
and outcome fields. Content providers additionally receive only eve's known
message, context, input-response, and output-schema fields; adapter-specific
payload fields are never projected.

The built-in OpenTelemetry provider maps each pair to an
`agent.channel.delivery` consumer span under the durable session window. When
`traceChannelRequests: true` creates an inbound HTTP server span, the delivery
span links to it with `eve.link.type=channel.request` rather than using the
short-lived request span as its parent.

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

The callback receives a session-frozen instrumentation channel snapshot:

- `session`: the session id, current and initiator auth, and parent session lineage when this is a child run
- `turn`: the stream turn id and sequence, for example `turn_0`
- `step`: the zero-based step index inside the turn
- `channel`: the channel's `kind` and the metadata projected by the active channel
- `modelInput`: the final instructions and messages passed to the model call

A channel exposes its identity through `kind`. For authored channels it is `channel:<name>`, where `<name>` is the channel's filename under `agent/channels/`, so `agent/channels/support.ts` is `channel:support`. Framework channels use `http`, `schedule`, or `subagent`, and an unrecognized or absent kind normalizes to `unknown`. The kind is also emitted as the `eve.channel.kind` span attribute. To access an authored channel's metadata with its precise type, import the channel definition and narrow with `isChannel(input.channel, supportChannel)`.

Channel metadata is channel-owned. Built-in channels expose only the fields they choose to make observable; Slack, for example, projects `channelId`, `teamId`, `threadTs`, and `triggeringUserId` from its durable channel state. User-authored channels expose their own projection by returning `metadata(state)` from `defineChannel`. eve snapshots this projection when the session is created, so later adapter state changes do not reclassify instrumentation. Runtime instrumentation never falls back to raw channel state.

## Authored trace hierarchy

When authored telemetry is enabled, each turn currently produces a trace like:

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

Set `traceChannelRequests: true` on `defineInstrumentation` to also wrap each inbound channel HTTP request in a single OpenTelemetry `SERVER` span named for the registered route, which parents the turn tree above (and any `hook.resume` and outgoing HTTP spans):

```text
POST /eve/v1/session/:sessionId
  └── hook.resume
        ├── GET hooks/by-token
        └── POST hook_received
```

The span stays low-cardinality (route template in `http.route`, method in `http.request.method`, never the concrete URL) and records no session ids, tokens, headers, bodies, or query parameters. It adopts an incoming `traceparent` as its parent when present, so eve requests correlate with upstream traces. It defaults to `false`; enable it only when you want these request spans.

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
- `$eve.trace_id`: trace id of the sampled agent trace containing the run, written on session, subagent, and turn rows so a dashboard run can be joined to its OpenTelemetry trace. Present only when the trace is sampled; absence means no exported OTEL trace exists.
- `$eve.is_trace_content_visible`: audience-based workflow privacy decision frozen when the session is created. It does not indicate whether a provider captured content before destination filtering.

Per-turn usage tags are written on each step of a turn, accumulating cumulative totals (last write wins):

- `$eve.model`: model id for the turn
- `$eve.input_tokens`, `$eve.output_tokens`, `$eve.cache_read_tokens`: running token counts
- `$eve.tool_count`: number of tools available to the turn

Tag writes are best-effort: a failure is logged once per process and then swallowed, so a broken tag emit never breaks the agent.

These tags power the **Agent Runs** tab in the Vercel dashboard. When you deploy on Vercel, the platform auto-detects `eve` as the framework and surfaces an Agent Runs view under your project's **Observability** tab, where you can browse sessions and drill into each conversation's trace, with no `instrumentation.ts` required. The tab is currently gated per team. See [Deploy to Vercel](./deployment/vercel#inspect-agent-runs) for enablement. Agent Runs is separate from the OpenTelemetry export above. Use OTel when you want spans in Braintrust, PostHog, Datadog, or another third-party backend.

## Local traces

Without an `instrumentation.ts`, `eve dev` records spans to disk — one trace per session, with turns, model steps, and tool calls. Read them two ways:

- [`/traces`](dev-tui#logs-and-traces) in the dev TUI: a live trace viewer that replays captured content as a conversation.
- [`eve traces`](../reference/cli#eve-traces): a span tree in the terminal, `eve traces ls` to list. Works after `eve dev` exits.

Local traces omit model and tool inputs and outputs by default. Set `EVE_TRACES_CONTENT=on` in `.env.local` to capture that content.

Writing `instrumentation.ts` replaces this: your `setup` takes over and nothing is recorded locally. For span attributes, retention, and the `EVE_TRACES*` variables, see [`eve traces`](../reference/cli#eve-traces).

## Debugging

`eve info` is the fastest way to see what eve actually picked up: ordered static instructions with their roles, plus the active tools, skills, subagents, schedules, routes, and discovery diagnostics. Dynamic instruction results exist only at runtime and are not part of this static inspection. eve also writes inspectable artifacts under `.eve/`, kept even when discovery hits errors:

| Artifact                        | Tells you                                   |
| ------------------------------- | ------------------------------------------- |
| `agent-discovery-manifest.json` | what eve found on disk                      |
| `diagnostics.json`              | authored-shape errors and warnings          |
| `compiled-agent-manifest.json`  | the serialized surface eve loads at runtime |
| `module-map.mjs`                | compiled module entrypoints eve imports     |

When `eve build` fails on discovery errors, the CLI prints the full diagnostics report (severity, message, source path) and the path to the diagnostics artifact.

### Common failures

| Symptom                                       | Likely cause and fix                                                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool not discovered (the model never sees it) | Run `eve info`. Confirm the file is in the right slot (`agent/tools/<name>.ts`) and default-exports `defineTool(...)`, and check `.eve/diagnostics.json` for shape errors. `schedules/` are root-only.                                                           |
| Model won't call a tool it should             | Tighten the tool `description` and `inputSchema`; put procedural guidance in a [skill](../skills), not the description. Confirm it's in the active set with `eve info`.                                                                                          |
| Stuck on `session.waiting`                    | The turn is parked for input. Answer the pending approval or question, or POST a follow-up to `/eve/v1/session/:sessionId`.                                                                                                                                      |
| 401 on production routes                      | Expected: auth fails closed. Replace `placeholderAuth()` with your route policy. Use `vercelOidc()` only for Vercel-issued tokens; otherwise configure `httpBasic()`, JWT/OIDC helpers, or a custom `AuthFn`. See [Authentication](./auth-and-route-protection). |
| Build fails with discovery errors             | Read the printed diagnostics and `.eve/diagnostics.json`; confirm the root-vs-subagent boundary is valid and secrets come from env vars.                                                                                                                         |

## What to read next

- [`agent.ts`](../agent-config)
- [Hooks](./hooks): observe the runtime event stream
- [Local Development](./dev-tui): drive the agent locally
- [Evals](../evals/overview): repeatable scored checks
