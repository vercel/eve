---
title: "Observability"
description: "Trace an agent with OpenTelemetry in instrumentation.ts, read the workflow run tags eve emits, and debug discovery with eve info and the common-failures table."
---

`instrumentation.ts` is where you configure how an eve agent is observed. The framework auto-discovers `agent/instrumentation.ts` and runs it at server startup before any agent code. Its presence implicitly enables telemetry, so there is no separate `isEnabled` toggle.

If you intend to export telemetry, review the exporter destination, data categories, and required legal approvals before enabling telemetry.

**The instrumentation provider API is experimental and off by default.** Enable `experimental.instrumentationProviders` to use its one-file-per-provider layout, directional content capture, and per-destination redaction. See [Instrumentation Providers](./instrumentation-providers) for setup and current limitations.

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

Any OTel-compatible backend works (Braintrust, PostHog, Sentry, Raindrop, Arize, Honeycomb, Datadog, Jaeger). Install the exporter package you need and configure it in the callback. The [PostHog AI Observability integration](/integrations/posthog-instrumentation) provides a ready-to-install exporter and optional user identification. The [Sentry integration](/integrations/sentry-instrumentation) provides a ready-to-install OTLP exporter that sends traces to Sentry without a Sentry SDK.

Three more fields control what eve and the AI SDK record inside those spans (see the AI SDK's [telemetry reference](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)):

- `recordInputs` records full message history on each step span. It defaults to `false`; set it to `true` to include input content.
- `recordOutputs` records model outputs and recalled memory records. It defaults to `false`; set it to `true` to include output content.
- `functionId` overrides the function name on spans (defaults to the agent name).

eve records metadata without model, tool, or memory-record content by default. Enable either content category only after reviewing the exporter and its data-retention path.

In the provider layout, eve stamps each span with `gen_ai.conversation.id`, which stays fixed across local and remote activations, including independent remote root workflows. Query this attribute to find the conversation's exported, retained traces; it does not grant access or control trace parenting. On Vercel, `vercel.session_id` additionally identifies the current Workflow run. See [Query exported traces](#query-exported-traces) for the cross-backend workflow.

You are responsible for ensuring any observability or eval provider is approved for the data exported to it.

The third configurable surface, [runtime context events](#runtime-context), attaches per-model-call values to these spans.

Built-in messaging channels classify their instrumentation metadata with an `audience`: `public`, `private`, or `unknown`. Slack public channels and Chat SDK workspace-visible threads are public; direct and private conversations are private; platform surfaces without enough visibility evidence remain unknown. Proactive Slack `receive` / `ctx.send` handoffs stay `unknown` unless the caller passes `audience` on the target, for example when a webhook or schedule already knows the destination channel is public.

## Channel delivery traces

Instrumentation providers receive `channel.delivery.started` followed by
`channel.delivery.completed`, `channel.delivery.cancelled`, or
`channel.delivery.failed` for every inbound channel operation. The lifecycle
covers durable processing through the terminal state of the resulting turn, not
messages an adapter sends back to Slack, Telegram, Twilio, or another platform.
Adjacent queued messages with matching authenticated identities and authorization
attributes can share a turn while retaining separate lifecycle pairs. An adapter
can also consume a delivery without starting a turn.

Each operation has a framework-owned `deliveryId` distinct from its optional
platform request ID. Metadata-only providers receive identity, channel, session,
and outcome fields. Content providers additionally receive only eve's known
message, context, input-response, and output-schema fields; adapter-specific
payload fields are never projected.

For a single delivery that starts a turn, the built-in OpenTelemetry provider records the channel kind, channel name, delivery ID, optional request ID, and captured input on that turn's `invoke_agent` activation. The activation remains a root in its own trace and links to the active upstream request or function span with `eve.link.type=channel.request`. Set `traceChannelRequests: true` to create an eve-owned HTTP server span as that link target; when the option is false, an already-active upstream span remains the target.

Deliveries that do not map one-to-one to an activation still produce instrumentation lifecycle events, but the built-in OpenTelemetry provider does not emit a separate delivery span.

## Callback delivery errors

Failed outbound session and task callback attempts emit an error-level
`[eve:execution.session-callback] callback delivery failed` runtime log without
requiring an instrumentation provider. Filter by `statusCode` for HTTP failures
or `failure` (`http`, `transport`, or `timeout`). The log includes the callback
origin, token-redacted route, payload kind, and available call, task, and child
session identifiers. Payload content, credentials, and callback tokens are
excluded. Each retry can emit a separate error; logging does not change Workflow
retry behavior. Best-effort activity delivery keeps its single
`[eve:execution.activity-submit] activity sink request failed` warning and does
not mark the active span as failed.

## Exported span names and outcomes

The built-in OpenTelemetry provider preserves each span's OTel name and adds
`operation.name` and `resource.name` for Datadog's operation/resource mapping:

| OTel span name                                                          | `operation.name`  | `resource.name`        |
| ----------------------------------------------------------------------- | ----------------- | ---------------------- |
| `invoke_agent weather`                                                  | `invoke_agent`    | `invoke_agent weather` |
| `execute_tool search`                                                   | `execute_tool`    | `execute_tool search`  |
| `chat <model>`                                                          | `chat`            | `chat <model>`         |
| `search_memory`, `upsert_memory`                                        | Same as span name | Same as span name      |
| `agent.step`, `agent.action`, `agent.approval`, `agent.channel.request` | Same as span name | Same as span name      |

These rows apply to eve-owned spans in local tracing and the
[instrumentation provider layout](./instrumentation-providers). They do not
rename Workflow, AI SDK, or other third-party spans, or change trace IDs,
parenting, sampling, or session grouping. Legacy `instrumentation.ts` setup
still owns its exporter configuration and
[authored trace hierarchy](#authored-trace-hierarchy).

In Datadog APM, `operation_name:invoke_agent resource_name:"invoke_agent weather"`
selects named agent invocations. Operation-based dashboards and monitors may
need to replace inferred names such as `otel.span` with these explicit names.
Keep session IDs, turn IDs, and message content in attributes, not operation or
resource names.

If an eve-owned span still appears as `otel.span`, inspect its exported OTel
name, `operation.name`, and `resource.name` before and after any drain or
Collector transforms. Datadog's [operation-name mapping
guide](https://docs.datadoghq.com/opentelemetry/migrate/migrate_operation_names/)
describes the explicit override. Exported fields must survive the ingestion
path; a local export does not prove that a hosted backend retained them.

Agent invocation spans carry `agent.turn.outcome=completed|failed|cancelled`
when the turn has a terminal outcome. A failed invocation also has OTel error
status; cancellation is not an error. The scalar outcome survives backends
that discard span events, including Sentry's [direct OTLP
intake](https://docs.sentry.io/concepts/otlp/direct/traces/). These attributes
remain available when model and tool content is redacted.

## Memory spans

eve records [OpenTelemetry GenAI memory spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/#memory) for provider calls. Recalls at `turn.started` and `compaction.completed` use `search_memory`; capture handlers use `upsert_memory`. They are client spans, following the GenAI memory convention for a call to a memory system.

Every memory span includes `gen_ai.operation.name` and `gen_ai.memory.store.id`. The store ID is eve's opaque `memory.scope.key`, which identifies the resolved scope without exposing the namespace or scope values. Recall spans set `gen_ai.memory.record.count` to their result count.

`gen_ai.memory.records` contains recalled record content only when `recordOutputs` is enabled. eve does not set `gen_ai.memory.query.text` because a memory provider receives structured conversation messages, not a standalone search-query string. The `agent.memory.slot` and `agent.memory.phase` attributes identify the eve slot and lifecycle boundary without adding either to the span name.

## Agent trace contract

The provider layout and zero-config local tracing emit the following spans.
The legacy `instrumentation.ts` layout still uses its authored OTel setup.

| Span                    | Meaning                                                  |
| ----------------------- | -------------------------------------------------------- |
| `invoke_agent <agent>`  | One agent activation in its own trace                    |
| `agent.step`            | One model attempt                                        |
| `chat <model>`          | One model call beneath its step                          |
| `agent.action`          | Durable action lifecycle, including dispatch and waiting |
| `execute_tool <tool>`   | In-process tool execution beneath its action             |
| `agent.approval`        | Approval waiting beneath its action                      |
| `search_memory`         | Recall memory records before a turn or after compaction  |
| `upsert_memory`         | Automatic memory capture                                 |
| `agent.channel.request` | Optional HTTP request span in the provider layout        |

For background tools and subagents, the AI SDK's `execute_tool` span ends when
the model receives the task receipt. The enclosing `agent.action` span remains
open until the background task completes, fails, or is cancelled. Its duration,
outcome, and usage describe the background task rather than the receipt.
Background tool results follow the output-content policy. Recorded task failure
details become bounded exception and status messages; redacted spans retain only
the failure outcome, error status, and error type. The initiating turn can
finish or be cancelled while the action remains open. Ending the session closes
an action whose task never reported a terminal result.

Schema v4 removes the session-long `agent.session` root and duplicate agent session and lineage attributes. Every eve span carries `agent.trace.schema.version=4` and `gen_ai.conversation.id`; Vercel deployments additionally carry `vercel.session_id`.
Only activations use the `invoke_agent` operation. Dispatch lifecycle spans use
`agent.action` with `agent.invocation.role=caller`; the built-in `agent` tool
executes under `execute_tool agent`. Turn IDs such as `turn_0` are local to a session,
so correlate turns by session ID and turn ID together.

A conversation remains durable state; `gen_ai.conversation.id` joins the activations that operate on it.

Each activation owns a fresh trace identity, including local and remote
subagents. The first child activation links to its caller with
`eve.link.type=agent.dispatch`; incoming `traceparent` provides that link, not
the child trace ID. Later turns do not reuse the original caller link.
Conversation baggage is independent of execution lineage and trace-policy
ceilings, which remain in force across the boundary.

Channel delivery does not allocate or replace the activation, and a later turn
receives a new trace. Samplers
see the activation name and attributes after its session coordinates are
available. Sampling must be deterministic for the same trace and operation
because durable reconstruction can evaluate it again.

Use `agent.turn.outcome` to distinguish completed, failed, and cancelled activations. A failed action can be handled by the agent without failing its activation; see [Exported span names and outcomes](#exported-span-names-and-outcomes).

Activation spans retain `gen_ai.usage.input_tokens` and
`gen_ai.usage.output_tokens` alongside `agent.usage.*` totals for that activation.
Model spans carry `gen_ai.usage.*`; step and dispatch spans report
`agent.usage.*`. Activation totals summarize that activation's own model calls, while caller spans can summarize delegated usage. Do not sum usage across these levels.

Nested dispatch spans are materialized when the child settles and handed to
span processors; successful materialization removes their completed records
from durable state. Settlement does not drain exporters or authored providers.
Materialization failures are logged without failing settlement, and exporter
draining follows the runtime's normal flush lifecycle.

Cancelled or abandoned dispatches retain
their outcome without error status. Error messages and stacks on eve spans count as
output content, including errors reconstructed after a worker replacement.
Metadata-only capture retains failure status without those details. Error logging
outside eve's instrumented execution retains its existing exception content.

Agent Runs activation metadata includes bounded principal summaries:

- `agent.principal.current.type` and `agent.principal.current.id` describe the current caller.
- `agent.principal.initiator.type` and `agent.principal.initiator.id` describe the authenticated principal that created the root session. The initiator remains fixed when later turns have a different caller.

Types are limited to `user`, `service`, `runtime`, `app`, `anonymous`, `local-dev`, `unknown`, `none`, and `other`. Types are emitted for every audience when a principal is present. An absent type means no authentication context was set; `none` means an explicitly null principal and has no ID. The auth layer's `unknown` type stays `unknown`; unrecognized authored types become `other`.

Principal IDs require a content-visible audience and a resolved trace decision that allows both `recordInputs` and `recordOutputs`. Public turns and unknown turns under `eve dev` can include IDs; private and hosted-unknown turns omit them. A user-configured trace policy or forwarded content ceiling that denies either direction omits both principal IDs before turn state is stored or sampled. Empty IDs and IDs larger than 1 KiB of UTF-8 data are omitted, not truncated; authentication records are unchanged. eve does not copy other authentication fields, such as claims, email attributes, issuers, or subjects, into these summaries.

## Query exported traces

Use a trace to investigate one activation's work. Use session and conversation attributes to find the other activations. Exporting to an OpenTelemetry backend does not turn a conversation into one continuous waterfall.

This workflow applies to schema v4 from the [instrumentation provider layout](./instrumentation-providers). Configure third-party exporters through `otelIntegration()` so they receive the same framework spans as local tracing and Agent Runs. The legacy `instrumentation.ts` setup emits the [authored trace hierarchy](#authored-trace-hierarchy), not this contract.

### Find an activation or conversation

| Investigation            | Filter                                                                  |
| ------------------------ | ----------------------------------------------------------------------- |
| Agent activations        | `agent.trace.schema.version=4` and `gen_ai.operation.name=invoke_agent` |
| One logical conversation | `gen_ai.conversation.id=<conversation ID>`                              |
| One turn                 | Both `gen_ai.conversation.id` and `agent.turn.id`                       |
| One Vercel Workflow run  | `vercel.session_id=<session ID>`                                        |
| Delegated dispatches     | `agent.invocation.role=caller`                                          |

Start with an activation filter for latency, failure, or turn-count dashboards. Every activation is a trace root. Within a conversation, group by trace ID, order activations by `agent.turn.sequence` or start time, and open the selected trace ID. Child activations link to their caller with `eve.link.type=agent.dispatch`; remote workflows keep their own execution lineage, so use conversation IDs and caller links for cross-deployment correlation.

For example, the built-in `agent` tool dispatches research into a new workflow and trace, and the next user turn starts another trace:

```text
Trace A
invoke_agent support                 session=S, turn=turn_0, conversation=S
  agent.step
    chat <model>
    agent.action                     role=caller, action.call_id=C
      execute_tool agent

Trace B
invoke_agent research                session=R, turn=turn_0, conversation=S
  link: agent.dispatch -> Trace A's caller action C
  agent.step
    chat <model>

Trace C
invoke_agent support                 session=S, turn=turn_1, conversation=S
  agent.step
    chat <model>
```

The conversation filter finds all three retained traces. eve initializes the conversation ID once and carries it through the existing parent context for local dispatch and `eve.conversation.id` baggage for remote dispatch. Remote session creation does not carry execution lineage or add authorization requirements for tracing. Existing authentication, principal forwarding, and root-session limits remain unchanged.

`traceparent` carries the caller's trace and span IDs for the causal link; adopting it as the child's parent would instead keep both in the same trace. Resolved trace-policy decisions and trusted remote content ceilings continue across this boundary independently of correlation, and an unsampled caller cannot be widened into a sampled child. No synthetic session span is needed.

Activation duration is elapsed time for that activation, including waits inside it, not the lifetime of the conversation or CPU time. Idle time between ended activations is not part of their durations. For token totals, choose one level: filter to `chat` model spans and sum `gen_ai.usage.*`, or filter to activations and sum their `agent.usage.input_tokens` and `agent.usage.output_tokens`. Exclude caller summaries from the activation total. Query cache usage on model spans. Do not add model, step, activation, and caller counters together.

### Search traces

Use your destination's span-search surface to filter by the attributes in the table, group activations by session or trace ID, and open one activation's trace waterfall. Use the OTel span name and `gen_ai.operation.name` to identify the operation. Preserve eve's ownership of the OTel provider; do not register a second provider merely to add a destination.

### Sampling and completeness

A session can contain both retained and missing activation traces. Head sampling, backend retention, destination filtering, and exporter failures all affect what a conversation query returns. Preserve the schema and correlation attributes in Collector transforms and destination policies, and configure indexing and retention for the queries above.

Do not interpret a missing activation as a missing execution, or sampled trace counts and token sums as an exact session ledger. A backend may receive descendants before the activation span finishes and exports; a temporarily missing root is not necessarily a broken parent ID. After deployment, verify a two-turn conversation and a delegation in the actual destination, including names, conversation grouping across services, separate trace roots, caller links, and outcome attributes.

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

## Authored trace hierarchy

When authored telemetry is enabled, each turn currently produces a trace like:

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

eve creates the `ai.eve.turn` parent span per turn and passes enriched telemetry to the AI SDK so model calls and tool executions are traced automatically. The AI SDK's OpenTelemetry integration names these spans after the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), so backends that understand `gen_ai.operation.name` can classify them without extra configuration. The `invoke_agent` span is named after the model; the agent name is on its `gen_ai.agent.name` attribute.

This hierarchy applies when eve passes telemetry to the AI SDK. When the `otel()` provider layout is declared and eve owns the agent spans, eve names its invocation span `invoke_agent <agent>` and its model-attempt spans `agent.step`. Session, turn, step, and channel context is injected as the framework half of the runtime context (`eve.version`, `eve.session.id`, `eve.environment`, `eve.turn.id`, `eve.turn.sequence`, `eve.step.index`, `eve.channel.kind`) and rides onto the spans alongside any values your `events["step.started"]` callback returns under `runtimeContext`.

Set `traceChannelRequests: true` on `defineInstrumentation` to also wrap each inbound channel HTTP request in a single OpenTelemetry `SERVER` span named for the registered route. In the authored hierarchy above, this span parents the turn tree and any `hook.resume` or outgoing HTTP spans. In the provider layout, `invoke_agent` remains a separate trace root and links to the request span.

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
- `$eve.schedule`: the authored schedule that created the session, including sessions started through a target channel
- `$eve.title`: truncated title derived from the first user message
- `$eve.trace_id`: sampled trace seed available when tagging a session, subagent, or turn run. Use it as a trace link, not a conversation-wide trace identity. Later activations can use other trace IDs; query `gen_ai.conversation.id` for the history. The tag does not confirm that a destination retained the trace.

Per-turn usage tags are written on each step of a turn, accumulating cumulative totals (last write wins):

- `$eve.model`: model id for the turn
- `$eve.input_tokens`, `$eve.output_tokens`, `$eve.cache_read_tokens`: running token counts
- `$eve.tool_count`: number of tools available to the turn

Tag writes are best-effort: a failure is logged once per process and then swallowed, so a broken tag emit never breaks the agent.

These tags power the **Agent Runs** tab in the Vercel dashboard. When you deploy on Vercel, the platform auto-detects `eve` as the framework and surfaces an Agent Runs view under your project's **Observability** tab, where you can browse sessions and drill into each conversation's trace, with no `instrumentation.ts` required. The tab is currently gated per team. See [Deploy to Vercel](./deployment/vercel#inspect-agent-runs) for enablement. Agent Runs is separate from the OpenTelemetry export above. Use OTel when you want spans in Braintrust, PostHog, Sentry, Datadog, or another third-party backend.

## Local traces

Without an `instrumentation.ts`, `eve dev` records spans to disk with one bounded trace per turn, including its model steps and tool calls. Read them two ways:

- [`/traces`](dev-tui#logs-and-traces) in the dev TUI: a live trace viewer that replays captured content as a conversation.
- [`eve traces`](../reference/cli#eve-traces): a span tree in the terminal, `eve traces ls` to list. Works after `eve dev` exits.

Local traces omit model, tool, and memory-record content by default. Set `EVE_TRACES_CONTENT=on` in `.env.local` to capture that content.

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
