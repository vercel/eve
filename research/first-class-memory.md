---
issue: https://github.com/vercel/eve/issues/1510
status: proposed
last_updated: "2026-08-18"
---

# First-class memory

## Proposal

Memory is a path-authored capability for scoped context that outlives one
session. A memory provider owns how it stores, retrieves, and updates memory.
eve owns when the provider participates in the agent lifecycle.

Each memory definition binds a provider to an application namespace, a trusted
scope, and a projection visibility policy. The provider contract has three
methods:

- `recall` updates the context projected into model calls.
- `save` observes history before compaction and after a completed turn.
- `tools` contributes model tools bound to the active memory scope.

eve calls each method at fixed boundaries. Recall and save receive a
discriminated `phase`, current turn coordinates, a stable operation ID, and the
address resolved for the slot. Tools are resolved once after turn-start recall
through the same durable dynamic-capability machinery as a `turn.started`
`defineDynamic` tool resolver.

```text
turn.started          ---> recall(phase: "turn.started") ---> tools
compaction.requested  ---> save(phase: "compaction.requested")
compaction.completed  ---> recall(phase: "compaction.completed")
turn.completed        ---> save(phase: "turn.completed")
```

eve owns namespace and scope resolution, invocation order, scope-bound context
projection, projection visibility, tool qualification, and replay behavior. The
provider owns storage, retrieval, ranking, extraction, formatting, retention,
and its model-facing operations. A hosted semantic service and a bounded text
file can therefore implement the same provider contract without sharing a
record or storage model.

## Public API at a glance

| Import path              | Public surface                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `eve/memory`             | `defineMemory`, `defineMemoryProvider`, `defaultNamespace`, provider contexts, addressing types, and projection types |
| `eve/memory/scope`       | `byPrincipal`                                                                                                         |
| `eve/memory/file`        | `fileMemory`, `inMemory`, and the portable document backend contract                                                  |
| `eve/memory/file/vercel` | `vercelBlob`                                                                                                          |

The smallest complete memory slot uses the built-in file provider:

```ts title="agent/memory/user.ts"
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  provider: fileMemory(),
  scope: byPrincipal,
});
```

For `agent/memory/user.ts`, eve derives the slot name `user`. Provider tools are
qualified with that identity, such as `user__save_memory` and
`user__remove_memory`.

## Authoring experience

An agent may declare one flat slot or a directory of named slots:

```text
agent/memory.ts            # one slot named "memory"
agent/memory/              # directory of named slots
  user.ts                  # slot named "user"
  workspace.ts             # slot named "workspace"
```

The flat file and directory forms are mutually exclusive. Each module
default-exports `defineMemory(...)`. The definition contains the provider, an
optional namespace, a required trusted scope, and optional eve-owned projection
policy:

```ts title="agent/memory/user.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { customMemory } from "../lib/custom-memory";

export default defineMemory({
  provider: customMemory,
  namespace: () => `acme:${process.env.DEPLOYMENT_REGION ?? "local"}`,
  scope: byPrincipal,
});
```

The same provider instance may back several slots. Their projections, tools,
and provider invocations remain independent. The default namespace includes the
slot identity, so each slot receives a distinct provider address. Definitions
that resolve the same custom namespace and scope intentionally share an address.

## Namespace

Namespace identifies the application-owned memory domain. It may be a string,
`null`, a promise, or a zero-argument resolver:

```ts
type MemoryNamespaceDefinition =
  string | null | Promise<string | null> | (() => string | null | Promise<string | null>);

function defaultNamespace(): string;
```

After resolving a non-null scope, eve awaits or invokes the namespace when it
locks memory for a lifecycle operation. A resolved `null` disables the slot for
that operation. If `namespace` is omitted, eve uses the exported
`defaultNamespace` function as the resolver. Its value includes the Vercel
project when available, otherwise a hash of the local application root, plus
the deployment environment, graph node, and path-derived memory slot.

Set `namespace` to define a custom application domain:

```ts
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { customMemory } from "../lib/custom-memory";

export default defineMemory({
  provider: customMemory,
  namespace: "acme:production:support-agent:user-memory",
  scope: byPrincipal,
});
```

A custom namespace is the complete namespace. eve does not append the
application root, deployment environment, graph node, or slot to the resolved
value.

## Scope

Scope identifies the trusted audience or container within a namespace. A scope
resolver receives a read-only snapshot of the authenticated session and active
channel. It may return a string, an array of string components, or `null`:

```ts
type MemoryScopeResolverResult = string | readonly string[] | null;

interface MemoryScopeContext {
  readonly abortSignal: AbortSignal;
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
  };
  readonly channel: {
    readonly kind?: string;
    readonly continuationToken?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

type MemoryScopeDefinition =
  | string
  | null
  | Promise<string | null>
  | ((
      context: MemoryScopeContext,
    ) => MemoryScopeResolverResult | Promise<MemoryScopeResolverResult>);
```

`eve/memory/scope` exports the built-in principal resolver:

```ts
function byPrincipal(context: MemoryScopeContext): string | null;
```

Scope must come from authenticated session context, application data, or trusted
channel state. Scope context deliberately excludes messages and current turn
input. A resolver that returns an array receives the convenience semantics of
`value.join(":")`; the array is not a collision-resistant tuple encoding. Each
component must be a non-empty string. eve resolves scope before namespace. A
`null` scope disables the slot without invoking its namespace resolver.
Otherwise eve resolves the namespace. A `null` namespace also disables the
slot. A disabled slot does not call the provider, expose its tools, or include
any of its projections in model context.

For an active slot, eve validates both values and derives the provider scope key
from exactly the resolved namespace and scope:

```ts
interface MemoryScope {
  /** Stable key derived from namespace and value. */
  readonly key: string;
  readonly namespace: string;
  readonly value: string;
}
```

The namespace separates independent application domains. The scope separates
audiences or containers inside that domain. The resolved pair is the only
variable input to the provider key. eve canonically encodes the pair before
hashing, so values cannot collide through string concatenation.

Every `recall`, `save`, and `tools` call receives this scope. Tools close over
the same locked scope, so the model never selects a different user, tenant, or
container. A conforming provider must apply `scope.key` or the namespace and
value to every downstream read and write. eve cannot prevent faulty provider
code from discarding the supplied scope, but the public contract provides no
unscoped provider invocation path.

eve locks scope for the active turn, including model steps and durable approved
call continuations. A standalone manual compaction resolves and locks scope for
that operation. Every projection remains attributed to the slot and scope key
under which it was recalled.

Passing `byPrincipal` as the scope resolver identifies the authenticated caller
from principal type, authenticator, optional issuer, and principal ID. It is a
pure consumer of the supplied `MemoryScopeContext`; it does not read ambient or
private runtime state. The function returns `null` for an unauthenticated
caller. Anonymous callers never share a memory scope.

Principal scope follows the same authenticated caller across channels. Memory
that is safe only within one channel or conversation must include the trusted
channel coordinates explicitly. Use `isChannel` to narrow authored channel
metadata before reading it:

```ts title="agent/memory/channel.ts"
import { isChannel } from "eve/channels";
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import slack from "../channels/slack";
import { customMemory } from "../lib/custom-memory";

export default defineMemory({
  provider: customMemory,
  scope: (ctx) => {
    if (!isChannel(ctx.channel, slack)) return null;

    const principal = byPrincipal(ctx);
    const { channelId, teamId } = ctx.channel.metadata;
    return principal === null || channelId === null || teamId === null
      ? null
      : [principal, teamId, channelId];
  },
});
```

The returned array resolves to `<principal>:<teamId>:<channelId>`. Include a
thread or conversation identifier as another component when the provider's
data must not cross that boundary. Resolver output is evaluated once when eve
locks the operation's memory scopes, and every provider call and tool in that
operation uses the locked value.

## Projection visibility across scope changes

`visibility` is an eve-owned `defineMemory` option. It controls which
previously recalled projections enter a model request when the slot resolves a
different scope. The option belongs to the consuming memory definition rather
than the provider because eve owns prompt assembly and the application owns the
session's audience boundary:

```ts title="agent/memory/user.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { customMemory } from "../lib/custom-memory";

export default defineMemory({
  provider: customMemory,
  scope: byPrincipal,
  visibility: "session",
});
```

```ts
type MemoryVisibility = "scope" | "session";
```

| Value               | Model context after a scope change                                                                                                          | Prompt cache                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `"scope"` (default) | Include only the projection whose scope key matches the active turn. Exclude projections recalled for earlier participants.                 | Filtering an anchored projection changes the prompt prefix and invalidates the affected cache.     |
| `"session"`         | Keep projections recalled for earlier scopes visible, then add the active scope's first projection immediately before its first turn input. | A scope change keeps earlier messages in place; replacing or clearing a projection may still bust. |

The default favors projection isolation over cache reuse when the authenticated
participant changes.

For a Slack thread where one authenticated participant follows another,
`"scope"` removes the first participant's recalled memory before the second
participant's model call. `"session"` keeps both projections visible. The
second mode is an explicit cross-scope disclosure policy and is appropriate
only when the session participants form one trusted audience.

```text
scope:   ... -> participant A turn -> assistant -> participant B projection -> participant B turn
session: ... -> participant A projection -> participant A turn -> assistant -> participant B projection -> participant B turn
```

This option never changes provider scope. `recall`, `save`, and `tools` still
receive only the active turn's locked scope. The provider cannot select the
visibility mode, and eve never passes another scope or its projection into a
provider method. A `null` scope suppresses all of the slot's projections in both
modes.

Projection visibility does not remove ordinary user, assistant, or tool
messages already in the conversation. It also cannot undo information an
earlier assistant response derived from memory. Applications that require hard
isolation between participants must use separate sessions. Provider tools that
return memory content place that content in ordinary tool history and therefore
own the same shared-session risk.

## Provider contract

`MemoryProvider` defines the operations available at memory lifecycle
boundaries. `recall` is required. `save` and `tools` are optional.

```ts
import type { ModelMessage } from "ai";
import type { SessionContext } from "eve/context";
import type { DynamicResolveContext, ToolDefinition } from "eve/tools";

interface MemoryProjection {
  /** Non-empty provider context projected as one synthetic user-role message. */
  readonly content: string;
}

interface MemoryTurnContext {
  readonly turnId: string;
  /** Zero-based durable turn sequence. The first turn is sequence 0. */
  readonly sequence: number;
  /** Normalized model messages accepted as input for this turn. */
  readonly input: readonly ModelMessage[];
}

interface MemoryOperationContext extends SessionContext {
  readonly abortSignal: AbortSignal;
  /** Durable model history at this lifecycle boundary. Excludes memory projections. */
  readonly messages: readonly ModelMessage[];
  /** Identifies one logical recall or save operation across workflow replay. */
  readonly operationId: string;
  readonly memory: {
    /** Current projection for this slot and the active scope, if one exists. */
    readonly current: MemoryProjection | null;
    readonly scope: MemoryScope;
    /** Path-derived slot identity, such as "memory" or "user". */
    readonly slot: string;
  };
}

type MemoryRecallContext = MemoryOperationContext &
  (
    | {
        readonly phase: "turn.started";
        readonly turn: MemoryTurnContext;
        readonly compaction?: never;
      }
    | {
        readonly phase: "compaction.completed";
        /** Null for standalone manual compaction. */
        readonly turn: MemoryTurnContext | null;
        readonly compaction: {
          readonly modelId: string;
        };
      }
  );

type MemorySaveContext = MemoryOperationContext &
  (
    | {
        readonly phase: "compaction.requested";
        /** Null for standalone manual compaction. */
        readonly turn: MemoryTurnContext | null;
        readonly compaction: {
          readonly modelId: string;
          readonly usageInputTokens: number | null;
        };
      }
    | {
        readonly phase: "turn.completed";
        readonly turn: MemoryTurnContext;
        readonly compaction?: never;
      }
  );

interface MemoryToolsContext extends DynamicResolveContext {
  readonly turn: MemoryTurnContext;
  readonly memory: {
    /** Current projection after turn-start recall. */
    readonly current: MemoryProjection | null;
    readonly scope: MemoryScope;
    /** Path-derived slot identity, such as "memory" or "user". */
    readonly slot: string;
  };
}

type MemoryRecallResult = MemoryProjection | null | undefined;
type MemoryToolSet = Readonly<Record<string, ToolDefinition>>;

interface MemoryProvider {
  recall(context: MemoryRecallContext): MemoryRecallResult | Promise<MemoryRecallResult>;

  save?(context: MemorySaveContext): void | Promise<void>;

  tools?(context: MemoryToolsContext): MemoryToolSet | null | Promise<MemoryToolSet | null>;
}
```

A provider can resolve tools asynchronously from authenticated or channel
context and capture the result in its executors:

```ts
import { defineMemoryProvider } from "eve/memory";
import { defineTool } from "eve/tools";

const customMemory = defineMemoryProvider({
  async recall(ctx) {
    return loadProjection(ctx.memory.scope.key);
  },
  tools: async (ctx) => {
    const policy = await loadToolPolicy(ctx.session.auth.current);

    return {
      search: defineTool({
        description: "Search memory",
        inputSchema: searchSchema,
        execute: (input) => searchMemory(ctx.memory.scope.key, policy, input),
      }),
    };
  },
});
```

The result of `recall` updates the active scope's projection:

| Result                          | Effect                                                  |
| ------------------------------- | ------------------------------------------------------- |
| `{ content: non-empty string }` | Replace the current projection for this slot and scope. |
| `null`                          | Clear the current projection for this slot and scope.   |
| `undefined` / no return         | Keep the current projection without changing it.        |

This distinction lets a provider skip routine turn-start retrieval without
losing previously recalled context. It can still clear stale context explicitly.
An empty string is invalid and fails recall at that lifecycle boundary; it does
not mean clear or skip. Providers return `null` to clear or `undefined` to
preserve the current projection.

`defineMemoryProvider(...)` is an identity-with-types helper. It does not add
storage behavior or impose a record model.

## Memory projection

Each slot stores at most one projection for every scope key it encounters in a
session. The durable projection state includes the slot, scope key, content, and
prompt anchor. `ctx.memory.current` exposes only the projection belonging to the
active scope.

The first valid projection for a scope anchors one synthetic user-role
message immediately before that scope's current turn input. Later recall results
update the projection at the same anchor according to the result table above.
Replacing, clearing, or filtering an anchored projection changes the prompt
prefix and may invalidate the provider prompt cache.

At model assembly, eve applies the slot's `visibility`. `"scope"` includes only
projections matching the active scope. `"session"` includes all of the slot's
projections in anchor order. Projections created at the same boundary use stable
slot-path order. The slot and scope attribution remain attached to each
projection throughout model assembly.

A projection remains separate from ordinary conversation history:

- It is not emitted as `message.received`.
- It is not summarized by compaction.
- It is not included in `ctx.messages` passed back to a provider.
- Its slot and scope attribution are not exposed to the model as tool input.

Although projections occupy stable positions among model messages for prompt
caching, they remain tagged framework state rather than ordinary durable
messages. That attribution is what lets eve filter them by scope.

Compaction removes anchors attached to the rewritten history. After the new
checkpoint, eve reanchors the projections visible for that operation and then
runs post-compaction recall for the active scope. A hidden projection reanchors
at the next turn boundary if its scope becomes visible again.

Providers own the content inside a projection. eve owns its user-role placement,
slot and scope attribution, filtering, and anchoring.

User-role instructions append application context to durable conversation
history at their lifecycle boundary. Memory projections are replaceable,
scope-bound provider context kept outside that history.

## Lifecycle

### Turn-start recall

After eve admits and normalizes a new turn, it resolves each memory scope and,
for a non-null scope, its namespace. It then calls `recall` with
`phase: "turn.started"` for every active slot. The context contains the
zero-based turn sequence, stable turn ID, normalized input, durable history
before the turn, and current projection for the active scope.

The first turn has `ctx.turn.sequence === 0`. A provider may use that coordinate
to recall only on the first turn. A provider may check
`ctx.memory.current === null` when it only needs to recall scopes without a
projection, including a new participant's scope on a later turn. A provider that
returns no projection or clears one will see `null` again at the next boundary.
A semantic provider may recall on every turn using the current input as its
query.

The result is ready before the first model call. If automatic compaction runs at
the same opening boundary, the projection remains outside compaction input and
the post-compaction recall may replace it before the model runs.

### Compaction save and recall

Before automatic or manual compaction rewrites history, eve calls an implemented
`save` method with `phase: "compaction.requested"`. The provider receives the
complete durable history about to be compacted, the active projection separately
as `ctx.memory.current`, and the compaction model and usage metadata. A provider
may persist a checkpoint, extract facts the summary could omit, or do nothing.

After a checkpoint is durably appended, eve calls `recall` with
`phase: "compaction.completed"`. The provider receives the settled
post-compaction history and can replace, clear, or preserve its current
projection. The call occurs after every successful automatic or manual
compaction, even when the provider skipped ordinary turn-start recall. Only the
active scope's projection can change during this call; visibility of other
projections remains eve-owned policy.

Provider tools are not resolved during a standalone compaction because no model
call follows that boundary.

### Turn tools

After turn-start recall settles, eve resolves `tools` once for the active turn.
The function may be synchronous or asynchronous. Its context contains the same
session, authentication, channel, and message fields as a `defineDynamic`
resolver, plus the locked memory scope, current projection, slot, and turn.
Returning `null` or an empty record exposes no tools for the slot.

The memory definition is implicit `defineDynamic` authoring: eve adapts each
implemented `tools` function to a `turn.started` dynamic resolver. The existing
dynamic tool engine owns asynchronous resolution, schema capture, closure
capture, approval and authorization behavior, durable replay, and executor
reconstruction for provider tools.

eve qualifies every returned key as `<slot>__<tool>` and binds the locked scope
to the tool implementation. Provider tools use the standard tool contract,
including input and output schemas, approval, authorization, and model-output
projection. In particular, `once()` approval is session-wide:
approving one qualified tool name also approves that name after a scope change.
Providers should use `always()` or a custom policy when approval must be
participant- or scope-specific.

The resolved tool set remains stable across every model step in the turn. When
a call parks on approval or authorization, eve retains that call's dynamic tool
metadata. The continuation reconstructs the exact originating definition,
including its captured scope, even if another participant has since started a
turn and replaced the current turn's tools. Resolver code does not run again.

A direct inline-authorization park follows the ordinary tool contract. The
unfinished assistant/tool exchange does not enter durable history, and the
callback makes the credential available only to its matching principal. It does
not replay the original tool execution. A later model step uses the same
turn-scoped tool set.

Resolver side effects occur once per admitted turn, while workflow replay
returns the recorded result. Provider mutations belong in the returned tool's
`execute` function. eve never substitutes the current turn's definition or
scope for a parked call's captured definition.

### Completed-turn save

After a turn reaches `turn.completed`, eve calls an implemented `save` method
with `phase: "turn.completed"`. The provider receives the completed turn input
and the settled durable history, including the assistant response and tool
results. The method does not run for failed, cancelled, input-deferred, or
adapter-consumed turns.

eve awaits completed-turn saves before emitting `session.waiting` in
conversation mode or `session.completed` in task mode. A provider may capture
the turn, update a remote profile, enqueue its own work, or do nothing.

## Replay and failures

Every recall and save invocation receives an `operationId` for one logical slot
operation. eve reuses the ID across workflow replay, so it is not a unique
callback-attempt identifier. A provider must use it as the idempotency key for
externally visible `save` side effects. eve records recall results, scope
attribution, prompt anchors, and turn-scoped dynamic tool metadata in durable
session state.

Failure behavior follows the point at which the method runs:

- A turn-start `recall` failure fails the active turn before the model runs.
- A `compaction.requested` save failure aborts compaction before history changes.
- A post-compaction `recall` failure cannot undo the checkpoint. It fails the
  active turn when compaction was automatic; standalone compaction emits a
  diagnostic and returns the session to waiting.
- A throwing or invalid `tools` result is diagnosed and omitted for the turn,
  matching `defineDynamic` tool resolution.
- A completed-turn `save` failure cannot rewrite the completed response. eve
  emits a content-free diagnostic and continues to the ready boundary.

## Built-in file memory

`fileMemory()` is the reference bounded-document provider. It stores one indexed
`MEMORY.md`-style document per memory scope key.

```ts
interface FileMemoryOptions {
  readonly backend?: MemoryDocumentBackend;
  /** Defaults to 100. */
  readonly maxEntries?: number;
}

function fileMemory(options?: FileMemoryOptions): MemoryProvider;
```

Its `recall` method loads the current document at every turn start and after
every successful compaction. Its `tools` method exposes
`save_memory({ text })` and `remove_memory({ index })`. Each tool completes after
its conditional write, and the next recall reflects the updated document.
`save_memory` normalizes whitespace, returns the existing index for duplicate
text, and fails when the document reaches `maxEntries`. `remove_memory` is a
no-op when its index is absent. The provider omits `save`: it does not run a
capture model or persist whole conversations.

The provider uses one portable conditional-document backend:

```ts
interface MemoryDocument {
  readonly content: string;
  readonly version: string;
}

interface MemoryDocumentBackend {
  read(input: { key: string; signal: AbortSignal }): Promise<MemoryDocument | null>;

  write(input: {
    content: string;
    expectedVersion: string | null;
    key: string;
    signal: AbortSignal;
  }): Promise<MemoryDocument>;
}
```

Process-local memory supports tests and non-Vercel development. A Vercel
deployment with an attached Blob store uses private Vercel Blob storage. Every
other production configuration requires an explicit backend. Every backend
implements the same optimistic read/replace contract.

The same lifecycle also supports a hosted semantic provider:

| Boundary               | Bounded file provider       | Hosted semantic provider                    |
| ---------------------- | --------------------------- | ------------------------------------------- |
| `turn.started` recall  | Load the current document   | Retrieve against the current turn input     |
| Post-compaction recall | Reload the current document | Refresh against the compacted history       |
| Pre-compaction save    | Omit                        | Preserve facts or checkpoint provider state |
| Completed-turn save    | Omit                        | Capture the completed interaction           |
| Turn tools             | Save and remove entries     | Provider-defined search, save, or forget    |

At each boundary, a provider may return `undefined` from `recall`, omit or do
nothing in `save`, or return `null` from `tools`.

## Provider packaging

A provider package exports a `MemoryProvider` or provider factory. It may own
credentials, remote APIs, migrations, retrieval, capture, and model tools. The
consuming agent owns the slot path, namespace, scope, and projection visibility.
Mounted extensions cannot contribute memory slots.

## Design invariants

- A slot is active only when both namespace and scope resolve to non-empty
  strings. Omitting `namespace` selects `defaultNamespace`; `null` disables the
  slot.
- The resolved namespace and scope are the only variable inputs to the provider
  key. Custom namespaces receive no path or deployment suffixes.
- One scope lock applies to every provider call, projection, model step, and
  durable tool continuation in an operation.
- Recall and save phases identify their exact lifecycle boundary. Every provider
  context includes durable history, the current projection, and a replay-stable
  operation ID.
- Projections enter model calls as scope-attributed user-role context but remain
  outside durable history and compaction input. `visibility` controls which
  projections enter the prompt after a scope change.
- A recall result can replace, clear, or preserve only the active scope's
  projection. Empty projection content is invalid.
- Provider tools are slot-qualified, scope-bound `turn.started` dynamic tools.
  Each turn resolves one complete tool set, every model step uses it, and a
  durable call keeps its originating definition until settlement.
- Completed-turn save settles before the next ready boundary.

## Non-goals

- A framework record, revision, citation, CRUD, query, ranking, embedding, or
  vector model.
- Framework-provided remember, forget, purge, export, or administrative APIs.
- A built-in capture model, extractor, formatter, retention policy, or erasure
  guarantee.
- Cross-provider search, mutation, or record reconciliation.
- Model-selected alternate scopes or unscoped provider invocations.
- Treating projection visibility as complete participant isolation for ordinary
  conversation messages or provider tool results.
- Preventing faulty or malicious provider code from ignoring the supplied scope.
- Standardizing provider credentials, migrations, inspection tools, or
  deployment operations.

## Primary references

- [Supermemory: how it works](https://supermemory.ai/docs/concepts/how-it-works)
- [Hermes Agent memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)
- [eve dynamic capabilities](../docs/guides/dynamic-capabilities.md)
- [eve agent configuration](../docs/agent-config.md)
- [eve turn execution](../packages/eve/src/execution/workflow-steps.ts)

## Review checklist

- [x] **Make channel-aware scope authorable.** Custom scope resolvers receive a
      read-only `MemoryScopeContext` with the abort signal, authenticated
      session, and channel metadata, but no messages or turn input.
      `byPrincipal` consumes that public context without private runtime access.
      Resolver arrays join non-empty components with `:`, while `null` preserves
      slot disablement. The authoring guidance states that principal scope
      crosses channels and shows how to add team, channel, and conversation
      coordinates for private memory. This resolves the [scope and Slack privacy
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807248748).

- [ ] **Decide what settled-turn metadata memory receives.** Determine whether
      `save` with `phase: "turn.completed"` receives aggregate input, output,
      cache, and cost usage, and document how `session.id` plus `turnId` link a
      memory operation to instrumentation. Explicitly keep failed, cancelled,
      and deferred turns in instrumentation, or add separate typed phases if
      memory providers are expected to learn from those outcomes. Close the
      [usage and trace
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807526107)
      and [terminal outcome
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807561187)
      once that boundary is unambiguous.

- [ ] **Give the model a safe memory-slot purpose.** Decide whether the
      consuming definition or provider configuration supplies a model-facing
      description that distinguishes destinations such as personal preferences
      and channel conventions. Keep raw namespace and scope values out of model
      input, and state that descriptions guide tool choice rather than enforce
      authorization. Verify that multiple `fileMemory()` slots expose enough
      information for the model to choose the intended qualified tool. Then
      close the [model-facing attribution
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807269437).

- [ ] **Explain projection placement and tool invocation semantics.** Keep or
      revise the current replaceable, scope-attributed projection model only
      after documenting its prompt-cache, chronology, stale-context, and suffix
      placement tradeoffs. State directly that eve invokes `recall` at fixed
      lifecycle boundaries and resolves the tool set once per turn, while the
      model decides whether to call an exposed tool. Close the [replacement and
      cache thread](https://github.com/vercel/eve/pull/1581#discussion_r3807382863),
      [suffix placement
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807481674),
      and [recall versus tool
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807408005)
      after the proposal records the chosen rationale.

- [ ] **Reconcile the remaining review threads with the final contract.**
      Correct the earlier additive-recall reply: the current contract keeps one
      replaceable projection per slot and scope. Correct the cross-provider
      reply: provider `ctx.messages` excludes other memory projections, and
      cross-provider reconciliation remains a non-goal. Reply to or resolve the
      remaining no-change questions about `phase`, `null` and `undefined`,
      visibility, and the namespace/scope split, then resolve the outdated and
      approval-only threads. Start with the [cross-provider
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807280622)
      and the [outdated turn-input
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3772094622).
