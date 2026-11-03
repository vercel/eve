---
issue: "TBD"
status: proposed
last_updated: "2026-11-03"
---

# Session folds

An alternative to [session labels (#5866)](https://github.com/vercel/eve/pull/5866). Instead of a built-in taint concept, eve
gives authors two small primitives: opaque labels on entries, and values derived from the session's
own events that carry across delegation. Exposure to untrusted content becomes a short library on
top of them.

## Problem

Some per-session facts must hold across a whole delegation tree and must survive interruption:

- whether the session has read content from outside its trust boundary, so a policy can gate later
  effects (prompt injection, [OWASP LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/));
- which tenants' or regions' data the session has touched;
- authored counters, such as external writes made by the tree.

Today authors write these with a hook and `defineState`. That has three gaps:

1. **Delegation.** `defineState` never crosses the parent and child boundary, so a child's value
   is lost when its result returns to the parent.
2. **Interruption.** If a step is interrupted after publishing an event but before its checkpoint,
   eve doesn't run hooks again for that event. The state update is lost, but the event is still on
   the stream.
3. **No shared telemetry.** Each agent stores and emits the value in its own way.

eve already solves all three for one value: usage. Usage is computed from `usage.recorded` events,
including events an interrupted attempt published. A child's usage reaches the parent as
`usage.recorded` events in the parent's stream, owned by the delegating call. This proposal makes
that mechanism available to authored values.

## Authoring API

### Labels on entries

Tools, connections, connection tools, subagents, and remote agents accept opaque `labels`. eve
doesn't interpret them. It records the resolved labels on the `call.requested` event, so a call's
labels are part of its history and don't change when the deployment does.

```ts title="agent/tools/read_issue.ts"
export default defineTool({
  description: "Read a GitHub issue.",
  inputSchema: z.object({ repo: z.string(), number: z.number() }),
  labels: ["reads:untrusted"],
  async execute(input) {
    /* ... */
  },
});
```

```ts title="agent/connections/github.ts"
export default defineMcpClientConnection({
  url: "https://example.com/mcp",
  labels: {
    default: ["reads:untrusted", "effect:external"],
    tools: { list_labels: [] },
  },
});
```

The approval context exposes the called entry's labels as `toolLabels`.

### Folds

`defineFold` declares a value computed from the session's events. Reducers are pure and
synchronous: they read the event and the session view, and return the next value.

```ts title="agent/lib/exposure.ts"
import { defineFold } from "eve/context";
import { call } from "eve/events";

export const exposure = defineFold("security.exposure", {
  initial: (): string[] => [],
  on: {
    "call.settled": (value, event, view) => {
      const labels = call(view, event.data.callId)?.labels ?? [];
      const reads = labels.filter((l) => l.startsWith("reads:")).map((l) => l.slice(6));
      return reads.length === 0 ? value : [...new Set([...value, ...reads])];
    },
  },
  delegate: { merge: "union" },
  emit: true,
});
```

Readers call `exposure.get()` wherever session context is active (tools, hooks, approval policies,
dynamic functions, telemetry resolvers), or `exposure.of(view)` on a snapshot such as `ctx.view`.

```ts title="agent/agent.ts"
import { exposure } from "./lib/exposure";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: ({ toolLabels }) =>
    exposure.get().includes("untrusted") && toolLabels.includes("effect:external")
      ? "user-approval"
      : undefined,
});
```

A packaged library can ship the label vocabulary, default labels for built-in tools, the fold, and
a stock policy. Adopting it is one import plus one `approval` line.

## Semantics

- **Derived, not stored.** A fold's value is a function of the session's events. eve updates it
  incrementally as events are published and caches it with the session projection. Nothing writes
  it directly.
- **Ordered before the next decision.** eve updates folds when it publishes an event, before the
  publisher continues. A call's approval, which eve decides just before the call runs, sees every
  event published before it. Calls from the same model response run concurrently, so a sibling may
  or may not see another sibling's result. The model hadn't read that result when it requested the
  sibling.
- **Interruption counts conservatively.** Recovery already folds the events an interrupted attempt
  published into the projection. A completed call whose result was lost still contributes its
  labels, so a fold can over-count but never miss an event.
- **Reducers must be pure.** No I/O, no clock, no randomness, and no reads of `defineState`, so
  replay gives the same value. eve calls reducers inside the step that publishes the event, and an
  error from a reducer fails the turn before its next model call.
- **Reducer changes apply to history.** A new deployment recomputes a fold from the session's
  events. A fixed reducer therefore corrects the value for existing sessions. A looser reducer also
  loosens it, so changing a security fold needs the same review as changing a policy.

### Delegation

A fold with `delegate` carries across delegation through events, the same way usage does:

```text
parent ── fold.inherited (at child open) ──▶ child stream
parent ◀── fold.recorded { owner: { callId } } ── child reports
```

- **Down.** When eve opens a local child (a subagent, the `agent` tool, a task, or `ctx.agent()`), it
  writes `fold.inherited` with the parent's current value to the child's stream. The child's fold
  starts from that value.
- **Up.** When eve counts a child's usage in the parent (with each reply for agent tasks, when the
  tool finishes for `execute` and `task` tools), it also writes `fold.recorded` with the child's
  current value and `owner: { callId }` to the parent's stream. The parent combines it with `merge`.
- **Merges.** `"union"` (sets), `"max"`, and `"sum"` are built in. `"sum"` adds what the child added
  since it inherited, so siblings that run concurrently are all counted. A function is allowed.
  Built-in merges can only grow the parent's value, and a function can't be checked for that.
- **Remote agents.** The caller sends `fold.inherited` values with the dispatch. The receiver accepts
  them only from deployments its `trustedForwarders` approves, which is the same decision that
  covers trace content limits. The receiver reports values back with its results. The caller merges
  them with whatever its own labels on the remote entry say about the call.
- **Dropping a value.** A delegating tool can declare `delegate: { drop: ["security.exposure"] }` to
  ignore a child's reported value. eve records the drop on `fold.recorded`, so telemetry shows it.
  Whether to restrict this to tools with bounded output schemas is an open question.

## Observability

A fold with `emit: true` is recorded, by name and value, on `agent.step` and `execute_tool` spans
and as a `$eve.fold.<name>` run attribute. Attribute names follow the schema 4 `agent.*` namespace
and are settled with the implementation. Values must be small and must not contain content. eve
rejects an emitted value over a fixed size.

Because `labels` are recorded on `call.requested`, an operator can query "an external call in a
session whose exposure includes `untrusted`" with no policy enforced.

## Compared with session labels

|                       | Session labels                          | Session folds                                 |
| --------------------- | --------------------------------------- | --------------------------------------------- |
| Core concepts         | labels, reads and effects, declassify   | entry labels, folds, delegation merges        |
| Taint vocabulary      | in eve                                  | in a library                                  |
| Durability            | framework-owned state                   | derived from events, like usage               |
| Other uses            | none                                    | tenancy, residency, authored counters         |
| Author effort (taint) | label tools, one policy line            | label tools, import library, one policy line  |
| Safety guarantees     | eve enforces monotonic labels           | only built-in merges are monotonic            |
| Defaults for builtins | eve ships them                          | the library ships them                        |

## Alternatives considered

- **Hooks with propagating `defineState`.** A `propagate` option on state, written by a
  `call.settled` hook. It's easy to explain, but hook writes are lost on interruption while the event
  stays on the stream, and a new transport would be needed for state between sessions. Folds reuse
  the event stream for both.
- **Built-in session labels.** See [session labels (#5866)](https://github.com/vercel/eve/pull/5866). This gives stronger
  guarantees with less author code for taint, but adds a security vocabulary to core that only one
  use case needs.
- **Status quo.** Hooks and `defineState` with no core change. This works for one session. Values
  launder through delegation and every agent emits different telemetry.

## Out of scope and follow-ups

- Folds over a child's full event stream. Children report their value, not their events.
- Folds that read memory providers or other external state.
- Exposing folds in `eve info` and the session API for frontends.

## Rollout

1. `labels` on entries, recorded on `call.requested`, plus `toolLabels` on `ApprovalContext`.
2. `defineFold` within one session, with `emit`.
3. Local delegation through `fold.inherited` and `fold.recorded`.
4. Remote delegation, then the packaged exposure library.
