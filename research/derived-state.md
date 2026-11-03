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
`agent/state/exposure.ts` is `exposure`. Extensions ship them under `extension/state/`, named by
mount path like their tools: `extension/state/exposure.ts` mounted as `taint` is `taint__exposure`.

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
  as it was requested: its `name`, `kind` (`tool`, `agent`, `skill`, or `control`), `tags`, `turnId`
  when a turn made it, `input`, and whether it is `remote`. An input too large for the stream to
  carry arrives as `inputRef`, with its size and a preview, and so does a large output on the
  event; reducers can't fetch the full value, so a state that needs one should bound it in the
  tool's schema. For
  `delivery.admitted`, `subject.delivery` has the message's `tags` (see
  [Message tags](#message-tags)). Progress events such as `content.delta` are not available.
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

The handle's `name` is the state's full name, including an extension's mount prefix, so code that
refers to the state, such as a client calling `derivedState(view, name)`, doesn't rebuild the prefix
by hand. When one file is mounted more than once, reading `name` throws and the caller passes the
name it wants.

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
- **Scope.** States in the root agent's `agent/state/`, and in extensions mounted on the root, run in
  the root session and in every local child: declared and dynamic subagents, the `agent` tool, tasks,
  and `ctx.agent()`. A subagent's own `agent/state/` and extensions add states for that subagent and
  its children. A security value can't be skipped by a subagent that forgets to declare it.

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
  receives `{ sessionId, callId, call }` as a third argument, where `call` is the delegating call as
  requested, the same shape as `subject.call`. A counter keeps the latest value per child session and
  sums when read, instead of adding the same total twice. Sets, maxima, and flags can ignore it. A
  state can use `call` to drop a child's value for a specific delegating tool.
- **Trust.** Local children are trusted. A remote agent accepts values going down only from a
  deployment its `trustedForwarders` approves, the same decision that covers forwarded identity and
  trace content limits. A parent accepts values coming up from a remote agent only for states it
  declares with `fromChild`. States match by name, so remote peers must use the same file name.
- **Monotonic only if you write it so.** eve doesn't enforce that a value only grows. Security states
  should combine with `||`, union, or max. A reducer change goes through the same review as a policy
  change.

All three carriers are optional fields or informational facts, which stream version 27 allows a minor
release to add.

### Message tags

Untrusted text also arrives as messages: a third party in a shared Slack thread, an inbound email, a
webhook from a public repository. A channel can attach `tags` to a message when it sends it to the
session, the same opaque strings tools use, and eve records them on its `delivery.admitted`. Built-in channels
add none in this version.

### Built-in tool tags

Built-in tools have no tags today, so a state can only recognize `web_fetch` by name, which misses
copies mounted under other names. eve gives the built-ins that reach the open web default tags:
`web_fetch` and `web_search` get `reads:untrusted` and `effect:external`, and so does `bash` when
its sandbox allows network access. An agent can replace a built-in's tags. These are the only tag
strings eve chooses, as a documented convention. eve still doesn't interpret them.

### Session audience

A channel's `audience()` already classifies each session as `public`, `private`, or `unknown` when
it starts, for trace content and run-data retention. Local children inherit it, and remote agents
accept it under `trustedForwarders`. Today it lives only in eve's internal state, so neither
reducers nor policies can read it. eve records it as an optional `audience` field on
`session.started`, and exposes it as `ctx.session.audience`, including on `ApprovalContext`.

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

## Proof: a taint extension

The second acceptance test is that taint tracking ships as an extension with no taint-specific code
in eve. Mounting the extension tracks exposure in every run, through subagents, and on traces.
Enforcing it is one line in `agent.ts`.

```ts title="extension/state/exposure.ts"
import { defineDerivedState } from "eve/context";

type Exposure = { readonly exposed: boolean; readonly sources: readonly string[] };

const add = (s: Exposure, source: string): Exposure =>
  s.sources.includes(source)
    ? { ...s, exposed: true }
    : { exposed: true, sources: [...s.sources, source].slice(-20) };
const merge = (s: Exposure, other: Exposure): Exposure =>
  other.sources.reduce(add, { ...s, exposed: s.exposed || other.exposed });
const untrusted = (tags: readonly string[] = []) => tags.includes("reads:untrusted");

export default defineDerivedState({
  initial: (): Exposure => ({ exposed: false, sources: [] }),
  on: {
    // the model reads a call's output unless the call was rejected before it ran
    "call.settled": (s, event, { call }) =>
      event.data.outcome !== "rejected" && untrusted(call.tags) ? add(s, call.name) : s,
    "delivery.admitted": (s, _event, { delivery }) =>
      untrusted(delivery.tags) ? add(s, "message") : s,
  },
  fromChild: merge,
  fromParent: merge,
  stream: true,
  telemetry: true,
});
```

```ts title="extension/policy.ts"
import type { ApprovalContext } from "eve/tools/approval";
import exposure from "./state/exposure";

export function taintPolicy({ exportTag = "effect:export", externalTag = "effect:external" } = {}) {
  return ({ toolTags }: ApprovalContext) => {
    const { exposed, sources } = exposure.get();
    if (!exposed) return undefined;
    if (toolTags?.includes(exportTag))
      return { type: "denied", reason: `Read untrusted content from ${sources.join(", ")}.` };
    return toolTags?.includes(externalTag) ? "user-approval" : undefined;
  };
}
```

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { taintPolicy } from "eve/extensions/taint";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: taintPolicy(),
});
```

- **Every run.** The state runs in the root and every local child, so a subagent can't launder what
  it read, and a child started by an exposed parent starts exposed.
- **Enforcement.** The agent-wide policy keeps the stricter of its answer and the tool's own. An
  approval that is still waiting is checked again against the exposure when someone answers it.
- **Hiding export tools.** Denying returns the reason to the model. To remove the tools from the
  model's list instead, a dynamic tools function reads `exposure.get()`.
- **Declassifying.** A `fromChild` that skips merging when `call.name` is a reader subagent with a
  bounded output schema is an extension option, not an eve rule.

It doesn't cover:

- **Memory.** Text captured in an exposed session comes back clean in later sessions, because recall
  isn't a call.
- **Workflow code.** A `ctx.agent()` call from workflow code isn't gated, so an effect taken directly
  in workflow code bypasses the policy. A local child's own calls are gated.
- **Remote agents without the extension.** Values cross only when both deployments mount it under
  the same name. Otherwise, tag the remote agent `reads:untrusted` so the call itself exposes the
  parent.

## Audience and taint

Audience and taint answer different questions, and a policy combines them:

|                | Audience                                   | Taint                                      |
| -------------- | ------------------------------------------ | ------------------------------------------ |
| Question       | who can read the conversation              | who could have written what the model read |
| Protects       | confidentiality                            | integrity                                  |
| Set by         | the channel, once, when the session starts | tagged results and messages, as they land  |
| Crosses agents | inherited, `trustedForwarders` for remote  | `fromParent`/`fromChild`, same trust gate  |

They don't imply each other. A company's public Slack channel has a public audience and trusted
writers. A Slack Connect DM has a private audience and an outside writer. A public GitHub repository
has a public audience and untrusted writers, so it needs both:

- **Integrity.** The GitHub channel tags messages from public repositories, or from people who
  aren't collaborators, `reads:untrusted`. The taint extension exposes the session from its first
  message, per message rather than per session.
- **Confidentiality.** When the audience isn't private, the reply is itself a path out: whatever the
  model reads can end up in a public comment. A policy gates tools that read private data whether or
  not the session is exposed.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { taintPolicy } from "eve/extensions/taint";

const taint = taintPolicy();

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
  approval: (ctx) => {
    if (ctx.session.audience !== "private" && ctx.toolTags?.includes("reads:private"))
      return { type: "denied", reason: "This conversation is visible outside the team." };
    return taint(ctx);
  },
});
```

Reading audience in a policy changes what a misclassification costs. Today the docs say audience
controls what traces capture and grants no authorization. Once a policy reads it, a session wrongly
classified `private` can reach private data. Policies should treat `unknown` like `public`, as the
example does, and the docs must say so.

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
  Here the taint extension owns that guarantee in its reducers.
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
- **Declassification in the taint extension.** Whether it offers dropping a child's exposure for
  delegating tools whose `outputSchema` has only bounded fields, and how it checks that.
- **Built-in channel tags.** Whether built-in channels tag messages from someone other than the
  session's caller, such as other people in a shared Slack thread.
- **Extension state names across deployments.** Remote matching depends on both sides mounting the
  extension under the same name. A state could instead declare a name that ignores the mount.
- **GitHub audience.** The GitHub channel doesn't classify audience today, so a public repository's
  session is `unknown`. Classifying it from the repository's visibility and tagging its messages are
  channel changes alongside this proposal.
- **Audience as derived state.** Audience is one value fixed at session start, inherited by local
  children and forwarded under `trustedForwarders`, which is the shape of a built-in derived state.
  Moving it would replace its own baggage member and propagation, but trace export reads it outside
  any session, so it waits until that path can read derived state.
- **History cost.** Whether computing a new state from full history needs a cap for very long
  sessions, and what it falls back to.

## Out of scope

- Reducers over a child's full event stream. Children send values, not events.
- Events written by authored code.
- Showing derived state in `eve info` or the dev TUI.
- Reading derived state from channel renderers and other server code that runs outside a session's
  context. That can be a later layer on the same values.

## Rollout

1. Built-in reducers move onto the definition shape, with no public API.
2. `defineDerivedState` in one session, with `stream` and `telemetry`, exported as experimental.
3. `fromChild` and `fromParent` for local children, then eve's usage on the same transport.
4. Message tags, built-in tool tags, `ctx.session.audience`, and `eve/extensions/taint` on public
   APIs only.
5. Remote agents.

## User docs

[derived-state-doc.md](./derived-state-doc.md) drafts the Core Concepts page that would ship with
step 2, as the test that the API explains in one page.
