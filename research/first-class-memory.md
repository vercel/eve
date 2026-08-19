---
issue: https://github.com/vercel/eve/issues/1510
status: proposed
last_updated: "2026-08-19"
---

# First-class memory

## Proposal

Memory is a path-authored capability for scoped context that outlives one
session. A memory provider owns how it stores, retrieves, and updates memory.
eve owns when the provider participates in the agent lifecycle.

Each memory definition binds a provider to an application namespace, a trusted
scope, and a recall visibility policy. It may also describe the slot's
purpose to the model through provider tool descriptions. The provider contract
has three methods:

- `recall` appends provider context to durable history as a user-role message.
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

eve owns namespace and scope resolution, invocation order, recall-message
attribution and visibility, tool qualification, and replay behavior. The
provider owns storage, retrieval, ranking, extraction, formatting, retention,
and its model-facing operations. A hosted semantic service and a bounded text
file can therefore implement the same provider contract without sharing a
record or storage model.

## Public API at a glance

| Import path              | Public surface                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `eve/memory`             | `defineMemory`, `defineMemoryProvider`, `defaultNamespace`, provider contexts, addressing types, and recall types |
| `eve/memory/scope`       | `byPrincipal`                                                                                                     |
| `eve/memory/file`        | `fileMemory`, `inMemory`, and the portable document backend contract                                              |
| `eve/memory/file/vercel` | `vercelBlob`                                                                                                      |

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
optional model-facing description, an optional namespace, a required trusted
scope, and an optional eve-owned visibility policy:

```ts title="agent/memory/user.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { customMemory } from "../lib/custom-memory";

export default defineMemory({
  description: "Personal preferences and durable facts for the authenticated user.",
  provider: customMemory,
  namespace: () => `acme:${process.env.DEPLOYMENT_REGION ?? "local"}`,
  scope: byPrincipal,
});
```

The same provider instance may back several slots. Their recalled messages,
tools, and provider invocations remain independent. The default namespace
includes the slot identity, so each slot receives a distinct provider address.
Definitions that resolve the same custom namespace and scope intentionally
share an address.

## Model-facing description

`description` is an optional static description of the slot's purpose:

```ts
interface MemoryDefinition {
  readonly description?: string;
  readonly namespace?: MemoryNamespaceDefinition;
  readonly provider: MemoryProvider;
  readonly scope: MemoryScopeDefinition;
  readonly visibility?: MemoryVisibility;
}
```

The consuming definition owns this description because one provider may back
several destinations with different purposes. For example, two `fileMemory()`
slots can distinguish personal preferences from shared channel conventions:

```ts title="agent/memory/personal.ts"
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  description: "Personal preferences belonging only to the authenticated user.",
  provider: fileMemory(),
  scope: byPrincipal,
});
```

```ts title="agent/memory/channel.ts"
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { channelScope } from "../lib/channel-scope";

export default defineMemory({
  description: "Shared conventions for this channel. Do not store personal preferences here.",
  provider: fileMemory(),
  scope: channelScope,
});
```

When the provider returns tools, eve prepends the slot description and two
newline characters to every provider-authored tool description. For example,
the first slot's `save_memory` description begins with its personal-memory
purpose before the provider's generic save guidance. eve performs this
composition after the `tools` resolver returns and before the dynamic tool
metadata is captured, so every model step and parked continuation sees the same
description. Omitting `description` preserves each provider tool description
unchanged. An empty or whitespace-only description is invalid; authors omit the
field when no slot-specific purpose is needed.

The description is trusted application-authored model guidance. eve does not
derive it from the slot name, namespace, scope, or request context, and does not
expose those values through it. The description is not added to recalled
messages or the prompt separately, so a provider without tools does not expose
it to the model. It helps the model choose among qualified tools but does not
enforce authorization or replace scope isolation.

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
its recalled messages in model context.

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
that operation. Every recalled message remains attributed to the slot and scope
key under which it was appended.

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

## Recall visibility across scope changes

`visibility` is an eve-owned `defineMemory` option. It controls which
previously recalled messages enter a model request when the slot resolves a
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

| Value               | Model context after a scope change                                                                                            | Prompt cache                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `"scope"` (default) | Include recalled messages whose slot and scope key match the active turn. Exclude recalled messages for earlier participants. | Filtering earlier messages changes the prompt prefix and invalidates the affected cache.      |
| `"session"`         | Keep every recalled message for the slot visible in its durable history position.                                             | Existing prompt messages remain in place; later recall results only extend the cached prefix. |

The default favors recalled-context isolation over cache reuse when the
authenticated participant changes.

For a Slack thread where one authenticated participant follows another,
`"scope"` removes the first participant's recalled memory before the second
participant's model call. `"session"` keeps both recalled messages visible. The
second mode is an explicit cross-scope disclosure policy and is appropriate
only when the session participants form one trusted audience.

```text
durable: ... -> participant A memory -> participant A turn -> assistant -> participant B memory -> participant B turn
scope:   ... -> participant A turn -> assistant -> participant B memory -> participant B turn
session: ... -> participant A memory -> participant A turn -> assistant -> participant B memory -> participant B turn
```

This option never changes provider scope. `recall`, `save`, and `tools` still
receive only the active turn's locked scope. The provider cannot select the
visibility mode. A `null` scope suppresses all recalled messages belonging to
the slot in both modes.

Recall visibility changes only scope-attributed recall messages in the model
request. It does not remove ordinary user, assistant, or tool messages from
durable history, and it cannot undo information an earlier assistant response
derived from memory. Applications that require hard isolation between
participants must use separate sessions. Provider tools that return memory
content place that content in ordinary tool history and therefore own the same
shared-session risk.

## Provider contract

`MemoryProvider` defines the operations available at memory lifecycle
boundaries. `recall` is required. `save` and `tools` are optional.

```ts
import type { ModelMessage } from "ai";
import type { SessionContext } from "eve/context";
import type { DynamicResolveContext, ToolDefinition } from "eve/tools";

interface MemoryRecallMessage {
  /** Provider context appended to durable model history. */
  readonly content: string;
  readonly role: "user";
}

interface MemoryMessageAttribution {
  readonly scope: MemoryScope;
  readonly slot: string;
}

function getMemoryMessageAttribution(message: ModelMessage): MemoryMessageAttribution | null;

interface MemoryTurnContext {
  readonly turnId: string;
  /** Zero-based durable turn sequence. The first turn is sequence 0. */
  readonly sequence: number;
  /** Normalized model messages accepted as input for this turn. */
  readonly input: readonly ModelMessage[];
}

interface MemoryOperationContext extends SessionContext {
  readonly abortSignal: AbortSignal;
  /** Durable model history at this lifecycle boundary, including prior recalls. */
  readonly messages: readonly ModelMessage[];
  /** Identifies one logical recall or save operation across workflow replay. */
  readonly operationId: string;
  readonly memory: {
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
    readonly scope: MemoryScope;
    /** Path-derived slot identity, such as "memory" or "user". */
    readonly slot: string;
  };
}

type MemoryRecallResult = MemoryRecallMessage | null | undefined;
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
    const content = await loadMemory(ctx.memory.scope.key);
    return content === null ? null : { content, role: "user" };
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

The result of `recall` is append-only:

| Result                              | Effect                                         |
| ----------------------------------- | ---------------------------------------------- |
| `{ content: string, role: "user" }` | Append one scope-attributed user-role message. |
| `null`, `undefined`, or no return   | Append nothing at this boundary.               |

eve applies the same content normalization as user-role instructions. It trims
the returned content and appends nothing when the result is empty after
trimming. A recall result never replaces, clears, or mutates an earlier message.

`defineMemoryProvider(...)` is an identity-with-types helper. It does not add
storage behavior or impose a record model.

## Recalled messages

Every non-empty recall result becomes one durable user-role message, using the
same message shape and append behavior as user-role instructions. Turn-start
recalls are appended immediately before the admitted turn input. Post-compaction
recalls are appended after the rewritten checkpoint and retained tail. Multiple
slots append in stable slot-path order.

eve records internal slot and scope attribution on each recalled message. The
attribution is not sent to the model or exposed as tool input. It exists so eve
can apply `visibility` at model assembly and so provider code can distinguish
recalled context from ordinary conversation messages. The message itself remains
part of `ctx.messages`, completed-turn saves, and later compaction input.

Recalled messages are not emitted as `message.received`; they are framework
context rather than new channel input. Compaction may summarize or discard them
like other durable user-role context. Before compaction, eve applies the active
visibility policy, so a scope-hidden recall cannot enter the checkpoint and is
removed with the rewritten history. The post-compaction recall boundary lets a
provider append fresh context when the rewritten history no longer contains it.

Append-only recall preserves the existing prompt prefix in the normal case. It
also means a provider owns repetition and correction policy. Returning the same
snapshot at every turn appends duplicates, while a later correction does not
delete an earlier claim. A provider returns `null` or `undefined` when it has no
new context to append.

## Lifecycle

### Turn-start recall

After eve admits and normalizes a new turn, it resolves each memory scope and,
for a non-null scope, its namespace. It then calls `recall` with
`phase: "turn.started"` for every active slot. The context contains the
zero-based turn sequence, stable turn ID, normalized input, durable history
before the turn, and prior recalled messages that remain in that history.

The first turn has `ctx.turn.sequence === 0`. A provider may use that coordinate
to recall only on the first turn. It may use `getMemoryMessageAttribution` to
find earlier recalls from the same slot and scope, return nothing when its
current context is already present, or recall on every turn using the current
input as its query.

The results are appended in stable slot order before the first model call. If
automatic compaction runs at the same opening boundary, the new messages enter
compaction input. Post-compaction recall may append fresh context after the
rewritten checkpoint before the model runs.

### Compaction save and recall

Before automatic or manual compaction rewrites history, eve calls an implemented
`save` method with `phase: "compaction.requested"`. The provider receives the
complete durable history about to be compacted and the compaction model and
usage metadata. A provider may persist a checkpoint, extract facts the summary
could omit, or do nothing.

After a checkpoint is durably appended, eve calls `recall` with
`phase: "compaction.completed"`. The provider receives the settled
post-compaction history and may append one fresh user-role message. The call
occurs after every successful automatic or manual compaction, even when the
provider skipped ordinary turn-start recall.

Provider tools are not resolved during a standalone compaction because no model
call follows that boundary.

### Turn tools

After turn-start recall settles, eve resolves `tools` once for the active turn.
The function may be synchronous or asynchronous. Its context contains the same
session, authentication, channel, and message fields as a `defineDynamic`
resolver, plus the locked memory scope, slot, and turn. Its messages include the
turn-start recall results followed by the admitted turn input.
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

Completed-turn save is a semantic memory boundary, not an instrumentation
export. It does not receive token usage, provider cost, latency, trace
identifiers, or unsuccessful outcomes. A provider that also consumes
instrumentation can correlate the two surfaces with `ctx.session.id` and
`ctx.turn.turnId`. The `usageInputTokens` field on `compaction.requested` is
specific to that boundary because it describes the context about to be
compacted.

eve awaits completed-turn saves before emitting `session.waiting` in
conversation mode or `session.completed` in task mode. A provider may capture
the turn, update a remote profile, enqueue its own work, or do nothing.

## Replay and failures

Every recall and save invocation receives an `operationId` for one logical slot
operation. eve reuses the ID across workflow replay, so it is not a unique
callback-attempt identifier. A provider must use it as the idempotency key for
externally visible `save` side effects. eve records recalled messages with their
scope attribution and keeps turn-scoped dynamic tool metadata in durable session
state.

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
every successful compaction. It appends the formatted document when the active
slot and scope do not already have an identical latest recall in durable
history. An empty or unchanged document appends nothing. Its `tools` method
exposes `save_memory({ text })` and `remove_memory({ index })`. Each tool completes after
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
| `turn.started` recall  | Append a changed document   | Retrieve against the current turn input     |
| Post-compaction recall | Append if context is absent | Refresh against the compacted history       |
| Pre-compaction save    | Omit                        | Preserve facts or checkpoint provider state |
| Completed-turn save    | Omit                        | Capture the completed interaction           |
| Turn tools             | Save and remove entries     | Provider-defined search, save, or forget    |

At each boundary, a provider may return `undefined` from `recall`, omit or do
nothing in `save`, or return `null` from `tools`.

## Provider packaging

A provider package exports a `MemoryProvider` or provider factory. It may own
credentials, remote APIs, migrations, retrieval, capture, and model tools. The
consuming agent owns the slot path, namespace, scope, and recall visibility.
Mounted extensions cannot contribute memory slots.

## Design invariants

- A slot is active only when both namespace and scope resolve to non-empty
  strings. Omitting `namespace` selects `defaultNamespace`; `null` disables the
  slot.
- The resolved namespace and scope are the only variable inputs to the provider
  key. Custom namespaces receive no path or deployment suffixes.
- One scope lock applies to every provider call, recalled message, model step, and
  durable tool continuation in an operation.
- Recall and save phases identify their exact lifecycle boundary. Every provider
  context includes durable history and a replay-stable operation ID.
- A non-empty recall result appends one scope-attributed user-role message to
  durable history. `null`, `undefined`, and empty normalized content append
  nothing; recall never mutates an earlier message.
- `visibility` controls which attributed recall messages enter a model request
  after a scope change. Session visibility preserves append-only prompt order;
  scope visibility may filter an earlier prefix.
- Provider tools are slot-qualified, scope-bound `turn.started` dynamic tools.
  Each turn resolves one complete tool set, every model step uses it, and a
  durable call keeps its originating definition until settlement.
- An optional static slot description is prepended to every provider tool
  description before durable capture. It never derives from or exposes the
  namespace or scope, and it guides model routing without granting access.
- Completed-turn save settles before the next ready boundary.

## Non-goals

- A framework record, revision, citation, CRUD, query, ranking, embedding, or
  vector model.
- Framework-provided remember, forget, purge, export, or administrative APIs.
- A built-in capture model, extractor, formatter, retention policy, or erasure
  guarantee.
- A memory-specific observability feed for usage, cost, latency, traces, errors,
  or cancelled turns.
- Cross-provider search, mutation, or record reconciliation.
- Model-selected alternate scopes or unscoped provider invocations.
- Treating recall visibility as complete participant isolation for ordinary
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

- [x] **Keep settled-turn telemetry out of memory.** `save` with
      `phase: "turn.completed"` receives completed input and durable history,
      but not usage, cost, latency, trace identifiers, or unsuccessful
      outcomes. Instrumentation owns that data and can be correlated through
      `session.id` plus `turnId`. `compaction.requested` retains its input-token
      count because that value describes the context being compacted. This
      resolves the
      [usage and trace
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807526107)
      and [terminal outcome
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807561187).

- [x] **Give the model a safe memory-slot purpose.** The consuming
      `defineMemory(...)` may supply an optional static `description`. eve
      validates it and prepends it to every provider tool description before
      storing durable dynamic metadata. Omitting it preserves provider
      descriptions unchanged. The implementation neither derives nor exposes
      namespace or scope values, and the docs distinguish model routing
      guidance from authorization. Unit coverage verifies two slots sharing one
      provider receive different descriptions without mutating provider tools;
      file-memory integration and e2e coverage exercise described
      `fileMemory()` slots. This resolves the [model-facing attribution
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807269437).

- [x] **Define recall placement and tool invocation semantics.** Every non-empty
      recall result appends one scope-attributed user-role message to durable
      history at its lifecycle boundary. `null`, `undefined`, and normalized
      empty content append nothing and never clear earlier history. Session
      visibility preserves append-only prompt order; scope visibility may
      filter earlier recalled messages after a scope change. eve invokes
      `recall` deterministically and resolves one tool set per turn, while the
      model decides whether to call an exposed tool. This resolves the
      [replacement and cache
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807382863),
      [suffix placement
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807481674),
      [recall versus tool
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807408005),
      [null sentinel
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807387086),
      and [falsy return
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807755029).

- [x] **Reconcile review threads with the final contract.** Provider
      `ctx.messages` includes recalled history, and
      `getMemoryMessageAttribution` identifies its originating slot and scope.
      The namespace/scope split, lifecycle phases, telemetry boundary, and
      cross-provider behavior now match the implementation. All outdated,
      approval-only, and superseded threads are resolved, including the
      [cross-provider
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807280622)
      and the [outdated turn-input
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3772094622).
