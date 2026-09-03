---
issue: TBD
status: proposed
last_updated: "2026-07-24"
---

# Agent-first OpenTelemetry semantics

## Summary

OpenTelemetry's [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
describe a _model call_. They are verbose by design — they carry full message
history and per-message content — and they never model the thing an operator
actually reasons about: the **agent run** and its structure. An agent run is a
tree (session → turn → step → action), it delegates, and it has lineage. None
of that is first-class in GenAI.

This document proposes a self-contained, vendor-neutral **`agent.*`** OTel
convention that treats the agent run as the primary subject. It is an
_independent_ convention, not a layer on top of GenAI: it does not require
GenAI attributes and does not inherit their payload cost. It defines the span
hierarchy, the attribute registry, and the span-event vocabulary together,
and then the natural extension points.

## What eve emits today (prior art)

eve already emits an agent-shaped vocabulary across its telemetry (see
[`docs/guides/instrumentation.md`](../docs/guides/instrumentation.md)). It is
summarized here as background — the `agent.*` design below is clean-slate, not a
one-to-one port.

**OTel spans.** eve opens one `ai.eve.turn` parent span per turn
([`packages/eve/src/harness/tool-loop.ts`](../packages/eve/src/harness/tool-loop.ts)) and lets the AI SDK emit the nested
`ai.streamText` (step), `ai.streamText.doStream` (model call), and `ai.toolCall`
spans. Delegated subagents get one caller-side `invoke_agent` span per child
result ([`packages/eve/src/execution/subagent-usage-span.ts`](../packages/eve/src/execution/subagent-usage-span.ts)).

**`eve.*` runtime-context keys** ride onto those spans
([`packages/eve/src/harness/instrumentation-runtime-context.ts`](../packages/eve/src/harness/instrumentation-runtime-context.ts)):
`eve.session.id`, `eve.turn.id`, `eve.turn.sequence`, `eve.step.index`,
`eve.channel.kind`, `eve.environment`, `eve.version`. The `eve.*` namespace is
reserved — authored runtime context that collides is dropped with a warning.

**`$eve.*` run tags** ([`packages/eve/src/execution/eve-workflow-attributes.ts`](../packages/eve/src/execution/eve-workflow-attributes.ts))
carry the structural tree: `$eve.type` (`session | turn | subagent`),
`$eve.parent`, `$eve.root`, `$eve.parent_call`, `$eve.parent_turn`,
`$eve.subagent`, `$eve.trigger`, `$eve.title`, `$eve.channel_request_id`.

The vocabulary is already agent-shaped; the convention below gives it a single
OTel-native home for identity, the tree, and lineage.

## The agent model

eve nests work in four levels. These are the nouns the convention names.

| Level       | What it is                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **session** | The durable conversation or task. Long-lived — may span many turns over days, and has no defined end (it can always resume via a channel-owned `continuationToken`). Identified by `sessionId`.                                                                           |
| **turn**    | One inbound message and all work it triggers until the agent responds. Has a stable `id` and a zero-based `sequence` within the session.                                                                                                                                  |
| **step**    | One model call **and the actions it requested, through their resolution** — the durable checkpoint boundary. Identified by a zero-based `index` within the turn.                                                                                                          |
| **action**  | One thing a step invokes, surfaced through eve's runtime action protocol: a **tool**, **skill** load, **subagent**, or **remote-agent** call, each with a `callId`. eve uses the _action_ umbrella (`actions.requested` / `action.result`) because these share one shape. |

Cross-cutting nouns: **channel** (the edge adapter; identity is `kind` —
`channel:<name>`, or framework kinds `http`/`schedule`/`subagent`),
**principal** (`principalId` + `principalType` of `app | user`), and
**lineage** — a subagent's `SessionParent` carries
`{ callId, sessionId, turn, rootSessionId }`, with `rootSessionId` denormalized
at every level so any descendant attributes itself to the root session
([`packages/eve/src/channel/types.ts`](../packages/eve/src/channel/types.ts)).
These are session-scoped, and because the session has no span (it is the trace)
they ride on each `agent.turn`: `agent.channel.kind` / `agent.trigger`,
`agent.principal.id` / `agent.principal.type`, and `agent.parent.*` /
`agent.root.session.id`.

## Proposed convention: spans

The model maps to a **logical** span tree. A consumer reconstructs it from the
session `traceId`, the identity attributes below, and span links — never from a
live parent chain.

| Span           | Represents                                          | Logical parent    |
| -------------- | --------------------------------------------------- | ----------------- |
| `agent.turn`   | one turn                                            | the session trace |
| `agent.step`   | one model call + the actions it requested, resolved | `agent.turn`      |
| `agent.action` | one tool / skill / subagent / remote-agent call     | `agent.step`      |

**The session is the trace, not a span.** A session is represented by its trace
identity, not a long-lived span; every span shares the session's `traceId` and
carries `agent.session.id`. Because OTLP events belong to spans rather than
traces, session lifecycle events are recorded on the `agent.turn` span during
which the transition occurs: `session.started` attaches to the first turn;
`session.waiting`, `session.completed`, and `session.failed` attach to the turn
that produces that outcome. If a session transition occurs without a turn, emit
a zero-duration `agent.session` marker span to carry the event. A producer may
also emit a zero-duration `agent.session` root marker for visualization, but —
having already ended — it does not own later lifecycle events. Session duration
is _derived_ (last activity − start).

**Step ownership.** A step is the model call _and the actions it requested,
through their resolution_, so `agent.action` is a child of `agent.step`, not of
`agent.turn`.

`agent.*` spans parent the AI SDK spans eve emits: `agent.step` parents
`ai.streamText` / `ai.streamText.doStream`, and an `agent.action` of kind `tool`
parents `ai.toolCall`.

```text
session trace                                {agent.session.id}
  ├─ agent.turn                              {agent.turn.sequence=0}
  │    ├─ agent.step                         {agent.step.index=0, agent.step.attempt=0}
  │    │    ├─ ai.streamText / .doStream     (model call, AI SDK)
  │    │    └─ agent.action                  {agent.action.kind=tool, agent.action.name=bash}
  │    │         └─ ai.toolCall              (AI SDK)
  │    └─ agent.step                         {agent.step.index=1}
  │         └─ agent.action                  {agent.action.kind=subagent, agent.action.name=researcher}
  └─ agent.turn                              {agent.turn.sequence=1}
       └─ …
```

**Subagents run in their own trace.** A delegated subagent's root links back to
the calling `agent.action` via a span **link**, and carries `agent.parent.*` /
`agent.root.session.id`, so the whole tree is reconstructable by query without
walking a live parent chain.

## Proposed convention: attributes

The `agent.*` registry. All are cheap scalars; none carries message content.

**Identity (run)**

| Attribute              | Type   | Notes                                                                            |
| ---------------------- | ------ | -------------------------------------------------------------------------------- |
| `agent.session.id`     | string | The agent run. On every span.                                                    |
| `agent.turn.id`        | string | Stable turn id.                                                                  |
| `agent.turn.sequence`  | int    | Zero-based turn position in the session.                                         |
| `agent.step.index`     | int    | Zero-based step index in the turn.                                               |
| `agent.step.attempt`   | int    | Zero-based attempt of a step; a **retry** increments it, a **replay** reuses it. |
| `agent.action.call_id` | string | Id of one action call.                                                           |

**Identity (agent & framework)**

| Attribute                 | Type   | Notes                                                                                                 |
| ------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `agent.name`              | string | The agent _definition_ (path-derived: package name / app-root basename; subagents use their node id). |
| `agent.version`           | string | The agent's own deployed revision.                                                                    |
| `agent.framework.name`    | string | Runtime framework — `eve`.                                                                            |
| `agent.framework.version` | string | Framework version.                                                                                    |

**Structure & lineage**

| Attribute                 | Type   | Notes                                                                                                                           |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `agent.action.kind`       | enum   | Discriminator: `tool` \| `skill` \| `subagent` \| `remote-agent` (open).                                                        |
| `agent.action.name`       | string | The invoked target's identifier, interpreted per `kind` (tool name, skill name, child agent name). Always present on an action. |
| `agent.parent.session.id` | string | Immediate parent session. **Absent at the root.**                                                                               |
| `agent.parent.turn.id`    | string | Parent turn that dispatched this run. Absent at the root.                                                                       |
| `agent.parent.call_id`    | string | Parent action call that spawned this run. Absent at the root.                                                                   |
| `agent.root.session.id`   | string | **Always present**; equals `agent.session.id` on a top-level session.                                                           |

`agent.action.kind` is the discriminator and `agent.action.name` is the single,
always-present name (rather than a per-kind `agent.tool.name` /
`agent.skill.name`), so "group actions by what they invoked" is one key and new
kinds don't each mint a name attribute. Kind-specific keys are reserved only for
facts _beyond_ the name — e.g. `agent.connection.name` / `agent.connection.protocol`
for a connection-backed tool, or `agent.subagent.node_id` for delegation. For
`kind=subagent | remote-agent`, the caller's `agent.action.name` equals the
child's own `agent.name` on the child's root, just as `agent.action.call_id`
mirrors the child's `agent.parent.call_id`.

**Context**

| Attribute            | Type   | Notes                                                                   |
| -------------------- | ------ | ----------------------------------------------------------------------- |
| `agent.channel.kind` | string | `channel:<name>`, or `http`/`schedule`/`subagent`; `unknown` if absent. |
| `agent.trigger`      | string | Channel kind that started the run.                                      |
| `agent.request.id`   | string | Inbound channel request id.                                             |
| `agent.environment`  | string | Deployment environment.                                                 |

**Principal**

| Attribute              | Type   | Notes                                         |
| ---------------------- | ------ | --------------------------------------------- |
| `agent.principal.id`   | string | Caller identity. Redactable (see invariants). |
| `agent.principal.type` | enum   | `app` \| `user`.                              |

### Deliberate divergences from GenAI

- **No message history by default.** GenAI's cost is that it records inputs and
  outputs. `agent.*` records _structure_. Content capture is opt-in, off by
  default (identifiers, by contrast, are on by default — see invariants).
- **"action", not "tool".** One attribute (`agent.action.kind`) covers tool,
  skill, subagent, and remote-agent calls, so delegation is not a special case.

## Proposed convention: events

eve already emits a lifecycle event stream (verified against
[`packages/eve/src/public/definitions/channel.ts`](../packages/eve/src/public/definitions/channel.ts) and the runtime). These map to
**span events** on the appropriate span. Each event carries only structural
references — ids, kinds, counts — never content. Small payloads are the point.

| Span                      | Events                                                                      |
| ------------------------- | --------------------------------------------------------------------------- |
| `agent.turn`              | `session.started`, `session.waiting`, `session.completed`, `session.failed` |
| `agent.turn`              | `turn.started`, `turn.completed`, `turn.failed`, `turn.cancelled`           |
| `agent.step`              | `step.started`, `step.completed`, `step.failed`                             |
| `agent.step`              | `actions.requested`, `action.result`                                        |
| `agent.action` (subagent) | `subagent.started`, `subagent.called`, `subagent.completed`                 |
| `agent.step`/`agent.turn` | `input.requested`, `authorization.required`, `authorization.completed`      |
| `agent.step`              | `reasoning.appended`, `reasoning.completed`                                 |
| `agent.turn`              | `compaction.requested`, `compaction.completed`                              |

**Canonical transitions, at-least-once emission.** Events denote canonical state
transitions, but under durable replay a producer cannot guarantee exactly-once
emission. Each event carries its transition identity (`agent.turn.id`,
`agent.step.index`, `agent.step.attempt`, `agent.action.call_id`) so a consumer
collapses duplicate emissions of the same transition. A **retry** is a new
attempt (new identity); a **replay** reuses the attempt (same identity, deduped).

`message.*` and `result.completed` events exist in the stream but carry content
and stay opt-in under the same content-capture flag as the history divergence
above.

## Natural extension points

The convention is designed to grow along the grain of the model.

- **New action kinds.** `agent.action.kind` is an open enum. Connection calls
  (MCP / OpenAPI) carry the qualified `<connection>__<tool>` in `agent.action.name`
  and add the kind-specific `agent.connection.name` / `agent.connection.protocol`.
- **Authorization & approval** are already lifecycle events; promoting them to
  `agent.authorization.*` attributes (method, principal type) makes sign-in
  gating queryable.
- **Compaction** becomes a first-class `agent.compaction` span. eve already
  isolates it (its model call is tagged `functionId: eve.compaction`), so the
  span has a natural home.
- **Reasoning** attaches as `reasoning.*` events today; a dedicated
  `agent.reasoning` span is the extension.
- **Delegation depth.** eve tracks `subagentDepth`; surfacing it as
  `agent.depth` lets a query bound or group deep trees.
- **Author-defined attributes.** The sanctioned extension mechanism already
  exists: the `events["step.started"]` runtime-context hook lets authors return
  values that ride onto spans. The convention reserves `agent.*` (as `eve.*` is
  reserved today) and directs authors to their own namespace
  (`support.channel_id`, etc.).

## Observable semantics & invariants

- **`agent.*` is reserved** (framework-owned), mirroring today's `eve.*`
  reserved-namespace rule. Authored code contributes only outside the namespace.
- **The tree is logical and emission-independent.** session → turn → step →
  action is reconstructed from the session `traceId` + identity attributes +
  links, never from live parent spans. One trace per session; subagents run in
  their own trace, linked by span links + `agent.parent.*` / `agent.root.*`.
- **Session has no writable span.** It is represented by the trace; its lifecycle
  events are recorded on the `agent.turn` where each transition occurs (or a
  zero-duration `agent.session` marker if there is no turn); duration is derived.
- **`agent.action` ⊂ `agent.step`.** A step is the model call plus the actions it
  requested, through resolution.
- **Failures are recorded on the span that failed, and do not propagate.** A
  failed `agent.action` sets status `ERROR` on _its own_ span (plus `action.result`
  / the matching `*.failed` event); it does **not** mark its `agent.step` or
  `agent.turn` `ERROR`. A step/turn is `ERROR` only if it itself fails to complete.
  A tool error the model then handles is a **successful turn with a failed
  action**; `agent.error.handled` (bool) distinguishes handled from fatal.
- **Lifecycle events are canonical transitions emitted at-least-once**, deduped by
  transition identity; a retry is a new attempt, a replay reuses the attempt.
- **Lineage is uniform.** `agent.root.session.id` is always present and equals
  `agent.session.id` at the root; `agent.parent.*` are absent at the root.
- **Identifiers open by default; PII redactable.** Structural identifiers emit in
  the clear. A redaction control can hash or drop PII-bearing attributes
  (`agent.principal.id` and any captured content) across traces. Message history
  and model outputs stay off by default.
- **Emission is best-effort.** A telemetry failure is logged once and swallowed;
  it never breaks a turn.

## Open questions

- **Redaction mechanism.** Hash vs. drop vs. allowlist, and which attributes are
  classified PII by default beyond `agent.principal.id`.
