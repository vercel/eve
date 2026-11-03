---
issue: "TBD"
status: proposed
last_updated: "2026-11-03"
---

# Derived state

> **AI status:** Written entirely by AI; human review pending.

Derived state is a per-session value that eve computes from the session's events with reducers you
write. It works like `defineState`, except nothing writes to it directly. Because the value is a pure
function of the stream, it survives interruptions, it can be read in approval policies and dynamic
functions, it can be streamed to clients, and it can follow work into subagents and back.

This is an alternative to [session labels (#5866)](https://github.com/vercel/eve/pull/5866). The
entry `tags` it relies on ship separately in [#5871](https://github.com/vercel/eve/pull/5871).

## Problem

Some per-session values have to be correct for the whole delegation tree and through interruptions:

- whether the session has read text that someone outside its trust boundary wrote, so a policy can
  ask before an external effect (prompt injection,
  [OWASP LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/));
- how much of a budget or deadline is left across a parent and its children;
- how many times the session did something with a quota, such as sending an email;
- which tenants or regions' data the session has touched.

Today an author builds these with a hook and `defineState`. That has three gaps:

1. **Interruption.** eve publishes an event and then runs hooks. If the step stops before its
   checkpoint, the retry adopts the event without running the hook again. The event stays on the
   stream and the state update is lost, so a quota undercounts and an exposure flag stays clear.
2. **Delegation.** `defineState` never crosses the parent and child boundary, so a subagent that read
   a public issue returns its answer to a parent that looks clean.
3. **Visibility.** Clients can't see the value without a custom tool or channel, and each agent emits
   it to telemetry its own way.

eve already handles all three for its own values. Usage totals, the usage-limit window, run and change
counters, and "this turn streamed output" are reducers over facts, kept with the session's cached
view (`SessionView.usage`, `SessionProjection` in `protocol/session-projection.ts`). Usage also crosses
agents, through three hand-written transports that turn a child's running total into a delta for the
parent. This proposal opens that mechanism to authors and moves eve's own values onto it.

## Authoring API

A derived state is a file under `agent/state/`. Its name comes from its path, so
`agent/state/exposure.ts` is `exposure`.

```ts title="agent/state/exposure.ts"
import { defineDerivedState } from "eve/context";

const untrusted = (tags: readonly string[] = []) => tags.includes("reads:untrusted");

export default defineDerivedState({
  initial: () => false,
  on: {
    "call.settled": (exposed, _event, { call }) => exposed || untrusted(call.tags),
  },
  fromChild: (exposed, child) => exposed || child,
  fromParent: (exposed, parent) => exposed || parent,
  stream: true,
});
```

- `initial` returns the value before the first event. Values are JSON.
- `on` maps [fact event types](../docs/concepts/sessions-runs-and-streaming.md), the same names hooks
  use, to reducers `(value, event, subject) => next`. For `call.*` events, `subject.call` is the call
  as it was requested: its `name`, `tags`, `input`, and whether it is `remote`. Progress events such as
  `content.delta` are not available.
- `fromChild` and `fromParent` say how a value from another session combines with this one. Leaving
  one out means values don't cross in that direction. See [Crossing agents](#crossing-agents).
- `stream: true` sends the value to clients. `telemetry: true` records it on spans.

Read the value with the default export, anywhere eve runs your code: tools, hooks, approval policies,
dynamic functions, `limits.sessionUsage` (which eve must start running with session context), and
OpenTelemetry resolvers.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import exposure from "./state/exposure";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: ({ toolTags }) =>
    exposure.get() && toolTags?.includes("effect:external") ? "user-approval" : undefined,
});
```

There is no `update()`. To change derived state, do something that produces an event, usually a tool
call. Values that come from outside the stream, such as an LLM judge's verdict in a hook, belong in
`defineState`.

### Choosing between state and derived state

|                         | `defineState`                         | `defineDerivedState`                   |
| ----------------------- | ------------------------------------- | -------------------------------------- |
| Written by              | your code, with `update()`            | reducers over the session's events     |
| Through an interruption | a hook's write can be lost            | recomputed from the events that landed |
| Subagents               | never shared                          | crosses when `fromChild`/`fromParent`  |
| Clients and telemetry   | not visible                           | opt in with `stream` and `telemetry`   |
| Good for                | plans, caches, values from I/O or LLM | counters, sets, flags, budgets, quotas |

## Semantics

- **A function of the events.** eve runs each reducer in the kernel's commit, as it folds the commit
  into the session view, before anything reads the result. An approval decided after a call settles
  sees that call. Calls from the same model response can run concurrently, so one call's policy may
  not see a sibling's result; the model hadn't read that result when it asked.
- **Interrupted steps count.** Recovery folds every line an interrupted attempt published, and line
  positions keep a replay from folding the same line twice. A call whose result was lost still counts.
- **Pure reducers.** No I/O, clock, randomness, or state reads. Use the event's `meta.at` for time. A
  reducer that throws fails the turn before its next model call.
- **History, once.** The first time a session meets a derived state it hasn't seen, such as after a
  deploy that adds `agent/state/exposure.ts`, eve computes it from the session's full history. After
  that it updates incrementally. Changing a reducer doesn't rewrite values the session already has;
  rename the file to recompute from history.
- **Bounded.** Each value is capped in size (proposed 16 KB serialized) and is checkpointed with the
  session. Unknown fields on events are ignored, so reducers should tolerate missing optional fields.
- **Scope.** States in the root agent's `agent/state/` run in the root session and in every local
  child: declared and dynamic subagents, the `agent` tool, tasks, and `ctx.agent()`. A subagent's own
  `agent/state/` adds states for that subagent and its children. A security value can't be skipped by
  a subagent that forgets to declare it.

### Crossing agents

```text
PARENT                                           CHILD
child.sent ─────────────────────────────────────▶ delivery.admitted { state: { exposure: false } }
                                                  ...turn: reads a public issue...
call.settled { state: { exposure: true } } ◀────── reply
child.reported { state: { exposure: true } } ◀──── later spend with no call to settle
```

- **Down.** With each delivery to a child, the parent sends the current value of every state the
  child declares with `fromParent`. The child records it on `delivery.admitted` and applies
  `fromParent`.
- **Up.** With each reply, the child sends the value of every state the parent declares with
  `fromChild`. The parent records it on `call.settled` for the delegating call, which is where the
  child's output enters the parent's context, and applies `fromChild`. A child that reports without
  a call to settle, such as a `serve` run after its reply, records `child.reported`.
- **Values are cumulative.** A child sends its whole value every time, not a delta. `fromChild`
  receives `{ sessionId, callId }` as a third argument, so a counter can keep the latest value per
  child session and sum when read, instead of adding the same total twice. Sets, maxima, and flags
  can ignore it.
- **Trust.** Local children are trusted. A remote agent accepts values going down only from a
  deployment its `trustedForwarders` approves, the same decision that covers forwarded identity and
  trace content limits. A parent accepts values coming up from a remote agent only for states it
  declares with `fromChild`. States match by name, so remote peers must use the same file name.
- **Monotonic only if you write it so.** eve doesn't enforce that a value only grows. Security states
  should combine with `||`, union, or max. A reducer change goes through the same review as a policy
  change.

All three carriers are optional fields or informational facts, which stream version 27 allows a minor
release to add.

## Clients and telemetry

Clients fold the stream themselves and don't have the agent's reducers. A state with `stream: true`
makes the kernel append `state.changed { name, value }` to any commit that changes it, at most once
per state per commit. `foldEvents` copies the value into the view, and `derivedState(view, "exposure")`
from `eve/events` reads it. States without `stream` stay on the server.

A state with `telemetry: true` is recorded on `agent.step` and `execute_tool` spans and as a run
attribute. Attribute names follow the schema 4 `agent.*` namespace and are settled with the
implementation. Tags are already on `call.requested` and tool spans, so "an external call in a session
whose exposure is set" is a query before any policy is enforced.

## Proof: eve's own values

eve's built-in reducers move onto the same definition shape, so the primitive is exercised by every
session and `SessionProjection` loses its bespoke fields.

1. **Same session.** `usage`, the usage-limit window, the run and change counters, and the
   output-started flag become built-in derived states named `eve.*`. Clients run eve's own reducers,
   so `usage(view)` and per-run and per-call usage rows don't change and need no `state.changed`.
2. **Across agents.** Usage reaches the parent through three hand-written cursors today: the child's
   `eve.harness.reportedSessionUsage` snapshot, the task table's previous run total, and the
   `ctx.agent()` run tally. With `fromChild`, every child sends its cumulative usage and the parent
   keeps the latest per child session. The kernel still records the difference as `usage.recorded`,
   so existing readers see the same events, but the subtraction happens in one place. Late spend
   arrives as `child.reported` and is still recorded with kind `delegated-late`.
3. **Tree-wide budget.** The [session usage limit](./session-usage-limit-function.md) left a
   tree-wide bound as a follow-up because a parent can't see a child's spend until it replies. A
   built-in or authored budget state with `fromParent` gives each child the parent's remaining amount
   at dispatch. Parallel children can still overshoot by what's in flight, as today.

The transport is not done until step 2 works. If it can't carry eve's own usage through tasks,
`serve` runs, persistent children, and remote callbacks, it isn't general enough to ship.

## More uses

Each of these is hard or unreliable with hooks and `defineState` today:

- **Effect quotas.** Count started calls tagged `effect:email` across the tree, and deny the next one
  after five. A lost hook write lets a sixth through.
- **Duplicate effects.** Keep the inputs of successful `create_pr` calls and deny an identical one,
  even after a retry or a context clear.
- **Tenant boundaries.** Collect `tenantId` from call inputs and ask before a write to a second tenant.
- **Escalation.** Count failed calls this turn and have a dynamic `model` switch to a stronger model
  after three.
- **Live progress.** Stream the set of files written or tests passing to a web UI, with no status tool.
- **Goals.** A goal's objective and status come from its tool calls, so the goal extension and the
  `/goal` harness example in the [session kernel doc](https://github.com/vercel/eve/pull/5644) can
  read them from derived state. Scanning `ctx.view` doesn't work for this on the server, which prunes
  call rows from earlier turns.

## Fit with the kernel and definitions

The [session kernel doc](https://github.com/vercel/eve/pull/5644) and its stack make the kernel the
only writer of facts and turn every authored file into a `Definition` with a stable `id`.

- A derived state is a definition whose contribution is a reducer. Its `id` is its path-derived name,
  the same id `ctx.keep` keys on.
- Reducers run inside the kernel's commit, where the stack already folds each commit into the
  projection. They aren't effects, which run after the commit, and they never emit facts. The kernel
  writes `state.changed`, `child.reported`, and the delegation fields.
- `ctx.keep` records the result of an evaluation that may not repeat. Derived state is the opposite: a
  value any process can recompute from facts. Both are checkpointed per definition id, but derived
  values belong with the projection, because eve can rebuild them from facts and `keep` values it
  can't. Any split of the checkpoint should keep that line.
- Kernel invariants don't change. Usage limits still run before every model call.

## Alternatives considered

- **Built-in session labels (#5866).** Stronger guarantees for one use case, with eve enforcing that
  labels only grow. It puts a security vocabulary in core and doesn't help budgets, quotas, or usage.
- **`defineState` that propagates, with replayed hooks.** Hooks do I/O, so replaying them is unsafe,
  and state would still need its own transport.
- **A separate `defineDelegation` with named entries.** An earlier draft. It repeats each name in
  `send`, `return`, and `accept`, which can drift, and its only use without a derived state was a
  budget, which is itself derived from usage.
- **Reducers that read `SessionView`.** Couples the public API to internal tables, and the server's
  view prunes closed rows, so a lookup by `callId` can fail. `subject.call` gives reducers what they
  need.

## Open questions

- **Naming.** `defineDerivedState` in `agent/state/`, or a separate `agent/derived/` slot to keep
  `defineState` handles distinct.
- **Ignoring a child's value.** Whether a delegating tool whose `outputSchema` has only bounded
  fields can drop a child's exposure, as #5866's declassification does.
- **History cost.** Whether computing a new state from full history needs a cap for very long
  sessions, and what it falls back to.

## Out of scope

- Reducers over a child's full event stream. Children send values, not events.
- Events written by authored code.
- Showing derived state in `eve info` or the dev TUI.

## Rollout

1. Built-in reducers move onto the definition shape, with no public API.
2. `defineDerivedState` in one session, with `stream` and `telemetry`, exported as experimental.
3. `fromChild` and `fromParent` for local children, then eve's usage on the same transport.
4. Remote agents, and an exposure library in `eve/tools/approval`.

## User docs

[derived-state-doc.md](./derived-state-doc.md) drafts the Core Concepts page that would ship with
step 2, as the test that the API explains in one page.
