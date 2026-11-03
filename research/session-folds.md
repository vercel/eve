---
issue: "TBD"
status: proposed
last_updated: "2026-11-03"
---

# Session folds and delegation context

An alternative to [session labels (#5866)](https://github.com/vercel/eve/pull/5866). Instead of a
built-in taint concept, eve adds three general primitives:

- **Entry labels.** Opaque labels on tools, connections, and agents, recorded on each call.
- **Folds.** Values that authors derive from the session's events.
- **Delegation context.** Authored entries that cross the parent and child boundary on events that
  already exist.

Exposure to untrusted content and a delegated budget each become short libraries on top of them.

## Problem

Some per-session values must hold across a whole delegation tree and survive interruption:

- whether the session has read content from outside its trust boundary, so a policy can gate later
  effects (prompt injection, [OWASP LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/));
- how much budget or time a child has left, out of its parent's;
- which tenants' or regions' data the session has touched.

Today authors write these with a hook and `defineState`. That has three gaps:

1. **Delegation.** `defineState` never crosses the parent and child boundary.
2. **Interruption.** If a step is interrupted after it publishes an event but before its checkpoint,
   eve doesn't run hooks again for that event. The state update is lost, but the event stays on the
   stream.
3. **Telemetry.** Each agent stores and emits the value in its own way.

eve already solves all three for usage. Usage is computed from `usage.recorded` events, including
events that an interrupted attempt published, and a child's usage reaches its parent as events in
the parent's stream. Separately, eve already sends **delegation context** to children: forwarded
identity, the parent session chain, and trace content limits, which `trustedForwarders` gates for
remote agents. This proposal opens both mechanisms to authors.

## Authoring API

### Entry labels

Tools, connections, connection tools, subagents, and remote agents accept opaque `labels`. eve
doesn't interpret them. It records the resolved labels on `call.requested`, so a call's labels are
part of its history and don't change when the deployment does. Approval policies read the called
entry's labels as `toolLabels`.

```ts title="agent/connections/github.ts"
export default defineMcpClientConnection({
  url: "https://example.com/mcp",
  labels: {
    default: ["reads:untrusted", "effect:external"],
    tools: { list_labels: [] },
  },
});
```

### Folds

`defineFold` declares a value computed from the session's events. Reducers are pure and synchronous.

```ts title="agent/lib/exposure.ts"
import { defineFold, union } from "eve/context";
import { call } from "eve/events";

const reads = (labels: readonly string[] = []) =>
  labels.filter((l) => l.startsWith("reads:")).map((l) => l.slice("reads:".length));

export const exposure = defineFold("security.exposure", {
  initial: (): string[] => [],
  on: {
    "call.settled": (value, event, view) =>
      union(value, reads(call(view, event.data.callId)?.labels)),
  },
  stream: true,
  telemetry: true,
});
```

Readers call `exposure.get()` wherever session context is active (tools, hooks, approval policies,
dynamic functions, telemetry resolvers), or `exposure.of(view)` on a snapshot such as `ctx.view`.

### Delegation context

`defineDelegation` decides what this agent sends to its children and returns to its parent, and
which entries it accepts. Entries are named JSON values.

```ts title="agent/delegation.ts"
import { defineDelegation } from "eve/context";
import { exposure } from "./lib/exposure";

export default defineDelegation({
  send: () => ({ "security.exposure": exposure.get() }),
  return: () => ({ "security.exposure": exposure.get() }),
  accept: ["security.exposure"],
});
```

eve records what crosses the boundary as an optional `delegationContext` field on two events that
already exist:

```text
PARENT stream                                   CHILD stream
call.requested (agent tool)
child.opened ─────────────────────────────────▶ session.started {parent}
child.sent ───────────────────────────────────▶ delivery.admitted {delegationContext}
                                                ...turn...
call.settled {delegationContext} ◀────────────── reply
```

A fold reads those events like any other:

```ts
on: {
  "call.settled": (value, event, view) => {
    const fromChild = event.data.delegationContext?.["security.exposure"] ?? [];
    return union(union(value, fromChild), reads(call(view, event.data.callId)?.labels));
  },
  "delivery.admitted": (value, event) =>
    union(value, event.data.delegationContext?.["security.exposure"] ?? []),
},
```

`ctx.session.delegationContext` returns the entries this session most recently received from its
parent.

## Semantics

### Folds

- **Derived, not stored.** A fold's value is a function of the session's events. eve updates it
  incrementally as it publishes events and caches it with the session view. Nothing writes it
  directly.
- **Ordered before the next decision.** eve updates folds when it publishes an event, before the
  publisher continues. A call's approval, which eve decides just before the call runs, sees every
  event published before it. Calls from the same model response run concurrently, so one may or may
  not see another's result. The model hadn't read that result when it asked for the call.
- **Interruption counts conservatively.** Recovery already folds the events that an interrupted
  attempt published into the view. A completed call whose result was lost still contributes its
  labels, so a fold can over-count but never miss an event.
- **Pure reducers.** No I/O, clock, randomness, or `defineState` reads, so replay gives the same
  value. eve runs reducers in the step that publishes the event. An error from a reducer fails the
  turn before its next model call.
- **Reducer changes apply to history.** A new deployment recomputes a fold from the session's events.
  A fixed reducer corrects existing sessions, and a looser one loosens them, so changing a security
  fold needs the same review as changing a policy.

### Visibility to clients

Clients build the session view themselves from the event stream with `foldEvents`, and they don't
have the agent's reducers. A fold with `stream: true` publishes `fold.changed { name, value }`
whenever its value changes. `foldEvents` copies that value into the client's view without running a
reducer, so the event stream stays the only contract between server and client. A fold without
`stream` is visible only on the server. `fold.changed` is an informational event, which stream
version 27 allows a minor release to add.

### Delegation context

- **On existing events.** Entries going down are recorded on the child's `delivery.admitted`, once
  per delivery, because a child can receive several deliveries and the parent's values can change
  between them. Entries coming up are recorded on the parent's `call.settled` for the delegating
  call, which is the point where the child's output enters the parent's context. Both are optional
  fields, which stream version 27 allows a minor release to add.
- **Durable on both sides.** Each side records what it received in its own stream, so folds,
  recovery, and replay treat it like any other event.
- **Accepted by name.** A session ignores entries it didn't list in `accept`. eve records the dropped
  names on the event.
- **Trust.** Local children are trusted. A remote child accepts entries only from deployments its
  `trustedForwarders` approves, the same decision that already covers forwarded identity and trace
  content limits. A parent accepts entries from a remote child it called only if they're in its own
  `accept` list.
- **Bounded.** Entry values are JSON, limited in size, and must not contain message or tool content.
  Content belongs in the call's input and output.
- **No ordering guarantee from the transport.** Whether a value can only grow depends on the
  reducer, not on delegation context. Security folds should use union or max.
- **Reserved names.** `eve.*` names are reserved. Forwarded identity, the parent session chain, and
  trace content limits can later be described as eve's own delegation context entries.

### Merging values from children

Delegation context only carries values. Folds decide how to combine them:

- **Sets and maxima** (`union`, `max`) can absorb the same child value more than once, which happens
  because a child reports with every reply.
- **Counters** can't be summed blindly. Keep the latest value per delegating call and sum when read:
  a grow-only counter keyed by `callId` (a G-Counter in state-based replicated data types). eve
  ships `union`, `max`, and `counter` helpers so authors don't write these by hand.

```ts
import { counter, defineFold } from "eve/context";

export const apiSpend = defineFold("billing.api-spend", {
  initial: counter.empty,
  on: {
    "call.settled": (value, event) =>
      counter.set(value, event.data.callId, event.data.delegationContext?.["billing.api-spend"]),
  },
});
// counter.total(apiSpend.get()) is the sum across children.
```

## Second example: delegated budget

Exposure flows up. A budget flows down. Today each child checks usage only against its own
`limits.sessionUsage`. With delegation context, a parent can pass down what it has left:

```ts title="agent/delegation.ts"
export default defineDelegation({
  send: ({ session }) => ({ "budget.remaining": remaining(session) }),
  accept: ["budget.remaining"],
});
```

```ts title="agent/lib/budget.ts"
export const budget = defineFold("budget.remaining", {
  initial: (): number | null => null,
  on: {
    "delivery.admitted": (value, event) =>
      event.data.delegationContext?.["budget.remaining"] ?? value,
  },
});
```

The child's `sessionUsage` then stops at the smaller of its own limit and `budget.get()`. The
parent already counts the child's usage through `usage.recorded`, so nothing needs to come back up.
Children running in parallel each receive the same remaining amount, so this cap is soft: it can
overshoot by whatever is in flight, as `sessionUsage` already can. A deadline works the same way.
This example assumes `sessionUsage` runs with session context, which the implementation must
confirm.

## Observability

A fold with `telemetry: true` is recorded on `agent.step` and `execute_tool` spans and as a
`$eve.fold.<name>` run attribute. Attribute names follow the schema 4 `agent.*` namespace and are
settled with the implementation. Delegation context entries are recorded on the existing
delegation spans by name, with values only for folds that opt into telemetry.

Because labels are recorded on `call.requested`, an operator can query "an external call in a
session whose exposure includes `untrusted`" with no policy enforced.

## Compared with session labels

|                       | Session labels (#5866)                | Folds and delegation context                   |
| --------------------- | ------------------------------------- | ---------------------------------------------- |
| Core concepts         | labels, reads and effects, declassify | entry labels, folds, delegation context        |
| Taint vocabulary      | in eve                                | in a library                                   |
| Durability            | state owned by eve                    | derived from events, like usage                |
| Crossing agents       | built-in label copy and union         | authored entries on existing events            |
| Other uses            | none                                  | budgets, deadlines, tenancy, counters          |
| Author effort (taint) | label tools, one policy line          | label tools, import a library, one policy line |
| Only-grow guarantee   | enforced by eve                       | depends on the reducer                         |

## Alternatives considered

- **Hooks with propagating `defineState`.** It's easy to explain, but hook writes are lost on
  interruption while the event stays on the stream, and state would need its own transport between
  sessions.
- **Fold-specific delegation events** (`fold.inherited`, `fold.recorded`). An earlier draft of this
  proposal. It ties transport to folds, adds two event types where optional fields on
  `delivery.admitted` and `call.settled` suffice, and leaves no way to send a value that isn't a fold.
- **Built-in session labels.** See #5866. Stronger guarantees and less author code for taint, but
  it adds a security vocabulary to core that only one use case needs.
- **Status quo.** Works for one session. Values launder through delegation and every agent emits
  different telemetry.

## Open questions

- **Child turns with no reply.** eve records their usage later as `usage.recorded` with kind
  `delegated-late`. Exposure doesn't need a late path, because no output reached the parent. A
  counter does, and the right home is still open.
- **Dropping a child's value.** Whether a delegating tool can ignore a child's entries, and whether
  to limit that to tools whose `outputSchema` has only bounded fields.

## Out of scope

- Folds over a child's full event stream. Children send values, not events.
- Folds that read memory providers or other external state.
- Showing folds in `eve info`.

## Rollout

1. `labels` on entries, recorded on `call.requested`, and `toolLabels` on `ApprovalContext`.
2. `defineFold` within one session, with `telemetry` and `stream`.
3. `defineDelegation` and the `delegationContext` fields for local children.
4. Remote agents, then the exposure and budget libraries.
