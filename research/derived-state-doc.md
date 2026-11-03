---
issue: "TBD"
status: proposed
last_updated: "2026-11-03"
---

# Derived state: user docs draft

> **AI status:** Written entirely by AI; human review pending.

A draft of `docs/concepts/derived-state.md` for the API proposed in
[derived-state.md](./derived-state.md). It describes proposed behavior as if shipped, so it isn't
published until the API ships. It would sit next to State under Core Concepts, and the State page
would link to it from its subagent section.

---

Derived state is a value eve keeps for you by watching the session's events. Each one lives in a
file under `agent/state/` and declares how each event changes the value. Use it for anything you
would count, collect, or flag: whether the session read untrusted text, how many emails it sent,
which tenants it touched.

```text
agent/
├── agent.ts
└── state/
    └── exposure.ts      # derived state "exposure"
```

```ts title="agent/state/exposure.ts"
import { defineDerivedState } from "eve/context";

export default defineDerivedState({
  // the value before any event
  initial: () => false,
  on: {
    // runs each time a tool call finishes; `call` is the call as the model requested it
    "call.settled": (exposed, _event, { call }) =>
      exposed || (call.tags ?? []).includes("reads:untrusted"),
  },
});
```

Read the value with the file's default export. This approval policy asks a person before any call
tagged `effect:external` once the session has read untrusted text:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import exposure from "./state/exposure";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: ({ toolTags }) =>
    exposure.get() && toolTags?.includes("effect:external") ? "user-approval" : undefined,
});
```

See [Tag entries for policies](../tools/human-in-the-loop#tag-entries-for-policies) for adding
`tags` to tools and connections.

## How derived state behaves

- **Nothing writes it.** Derived state has `get()` but no `update()`. To change it, do something that
  records an event, usually a tool call.
- **Up to date before the next decision.** eve applies each event before an approval policy, tool, or
  model call that comes after it. Calls the model requested in the same response can run at the same
  time, so one call's policy may not see another's result.
- **Survives restarts and redeploys.** eve recomputes the value from the events that were recorded,
  so an interrupted step can't lose an update.
- **Starts from the session's history.** When you add a derived state to an agent with existing
  sessions, eve computes it from each session's full history the first time it runs there. Changing
  a handler later doesn't change values a session already has. Rename the file to recompute from
  history.
- **The name comes from the path.** `agent/state/exposure.ts` is `exposure`, and
  `agent/state/billing/spend.ts` is `billing/spend`.

## Write handlers

Handlers are keyed by event type, using the same names as [hooks](../guides/hooks), and receive
`(value, event, subject)`. They return the next value.

- Handlers must be pure. Don't do network or file I/O, read the clock, use randomness, or read
  `defineState`. Use `event.meta.at` for the time an event was recorded.
- `subject.call` is present for `call.*` events. It has the call's `name`, `tags`, `input`, and
  `remote`, as the model requested it.
- Progress events such as `content.delta` and `call.progress` aren't available.
- A handler that throws fails the turn before its next model call.
- Values are JSON and can be up to 16 KB.

This one counts every email send that started, including ones that failed, because a failed send
may still have reached the provider. A call starts only after any approval it needs:

```ts title="agent/state/emails-sent.ts"
import { defineDerivedState } from "eve/context";

export default defineDerivedState({
  initial: () => 0,
  on: {
    "call.started": (count, _event, { call }) =>
      (call.tags ?? []).includes("effect:email") ? count + 1 : count,
  },
});
```

## Options

| Option       | Type                                            | Default  | Description                                     |
| ------------ | ----------------------------------------------- | -------- | ----------------------------------------------- |
| `initial`    | `() => T`                                       | required | The value before any event.                     |
| `on`         | `{ [eventType]: (value, event, subject) => T }` | required | How each event changes the value.               |
| `fromChild`  | `(value, child, source) => T`                   | omitted  | Combine a subagent's value into this session's. |
| `fromParent` | `(value, parent) => T`                          | omitted  | Combine the parent's value into a subagent's.   |
| `stream`     | `boolean`                                       | `false`  | Send the value to clients.                      |
| `telemetry`  | `boolean`                                       | `false`  | Record the value on traces.                     |

## Share with subagents

Derived state in the root agent's `agent/state/` runs in the root session and in every local child:
declared and dynamic subagents, the built-in `agent` tool, tasks, and `ctx.agent()`. Each child
keeps its own value. A subagent's own `agent/state/` adds derived state for that subagent and its
children.

To move values between a parent and its children, add `fromChild`, `fromParent`, or both:

```ts title="agent/state/exposure.ts"
import { defineDerivedState } from "eve/context";

export default defineDerivedState({
  initial: () => false,
  on: {
    "call.settled": (exposed, _event, { call }) =>
      exposed || (call.tags ?? []).includes("reads:untrusted"),
  },
  // a child that read untrusted text exposes the parent when its answer arrives
  fromChild: (exposed, child) => exposed || child,
  // a child starts exposed when its parent already is
  fromParent: (exposed, parent) => exposed || parent,
});
```

- eve sends the parent's value with each message to a child, and the child's value with each answer
  it returns. A child whose value changes after it answers, such as a background task, sends its
  value again.
- A child always sends its whole current value, not what changed. To add up values from children,
  keep the latest one per child and sum when you read it. `source.sessionId` identifies the child,
  and `source.call` is the parent's call that delegated to it:

```ts title="agent/state/api-spend.ts"
import { defineDerivedState } from "eve/context";

export default defineDerivedState({
  initial: () => ({ own: 0, children: {} as Record<string, number> }),
  on: {
    "call.settled": (spend, _event, { call }) =>
      call.name === "query_api" ? { ...spend, own: spend.own + 1 } : spend,
  },
  fromChild: (spend, child, { sessionId }) => ({
    ...spend,
    children: { ...spend.children, [sessionId]: child.own + total(child.children) },
  }),
});

const total = (children: Record<string, number>) =>
  Object.values(children).reduce((sum, n) => sum + n, 0);
```

- [Remote agents](../guides/remote-agents) use the derived state in their own deployment. Values
  cross only when both agents declare a derived state with the same name. A remote agent accepts
  values from a parent only when its `trustedForwarders` accepts the caller.
- eve doesn't stop a value from shrinking. For a value that guards an effect, combine with `||`, a
  set union, or `Math.max`, so a child can't clear what the parent learned.

## Ship derived state in an extension

An [extension](../extensions) ships derived state under `extension/state/`. Its names take the
mount path, like the extension's tools: `extension/state/exposure.ts` mounted as `taint` is
`taint__exposure`. Derived state from an extension mounted on the root agent runs in every local
child, the same as the root's own `agent/state/`.

An extension can't set the agent's approval policy. Export a policy function and have the agent use
it:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { taintPolicy } from "eve/extensions/taint";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: taintPolicy(),
});
```

## Show derived state in a client

Set `stream: true` to send the value to clients. eve records a `state.changed` event whenever the
value changes, and `derivedState` from `eve/events` reads it from the session view:

```ts title="app/progress.tsx"
import { derivedState } from "eve/events";
import { useEveAgent } from "eve/react";

export function Progress() {
  const { view } = useEveAgent();
  const files = derivedState<string[]>(view, "files-written") ?? [];
  return <p>{files.length} files written</p>;
}
```

Derived state without `stream` stays on the server. Leave it off for values that contain data the
client shouldn't see.

## Record derived state on traces

Set `telemetry: true` to record the value on the agent's step and tool spans. Combined with the tags
on tool spans, you can find sessions that made an external call after reading untrusted text before
you enforce any policy. See [Telemetry](../reference/telemetry) for attribute names.

## Derived state or `defineState`

|                       | `defineDerivedState`                     | `defineState`                                |
| --------------------- | ---------------------------------------- | -------------------------------------------- |
| Changed by            | events, through your handlers            | your code, with `update()`                   |
| After an interruption | recomputed from recorded events          | an update from a hook can be lost            |
| Subagents             | shared with `fromChild` and `fromParent` | never shared                                 |
| Clients and traces    | with `stream` and `telemetry`            | not visible                                  |
| Use for               | counts, sets, flags, budgets, quotas     | plans, caches, results of I/O or model calls |

Use [`defineState`](./state) when the value comes from somewhere other than the session's events,
such as an API response or a model's judgment in a hook.
