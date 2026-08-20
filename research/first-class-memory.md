---
issue: https://github.com/vercel/eve/issues/1510
status: proposed
last_updated: "2026-08-20"
---

# First-class memory

## Proposal

Memory is a path-authored capability for scoped context that outlives one
session. A memory provider owns how it stores, retrieves, and updates memory.
eve owns when the provider participates in the agent lifecycle, and eve owns a
small projection record model — item identity and supersession — so recalled
context can be updated deterministically without a stale copy surviving in the
prompt.

Each memory definition binds a provider to an application namespace, a trusted
scope, and a recall visibility policy. It may also describe the slot's
purpose to the model through provider tool descriptions. The provider contract
has three methods:

- `recall` returns messages that eve applies to the slot's recalled context in
  durable history as user-role context. A message with an `id` inserts or
  replaces that item; a message without one appends immutably.
- `capture` observes history before compaction and after a completed turn.
- `tools` contributes model tools bound to the active memory scope.

eve calls each method at fixed boundaries. Recall and capture receive a
discriminated `phase`, current turn coordinates, a stable operation ID, and the
locked memory scope resolved for the slot. Tools are resolved once after
turn-start recall through the same durable dynamic-capability machinery as a
`turn.started` `defineDynamic` tool resolver.

```text
turn.started          ---> recall(phase: "turn.started") ---> tools
compaction.requested  ---> capture(phase: "compaction.requested")
compaction.completed  ---> recall(phase: "compaction.completed")
turn.completed        ---> capture(phase: "turn.completed")
```

eve owns namespace and scope resolution, invocation order, recall validation
and application, recall-record attribution and visibility, projection, tool
qualification, and replay behavior. The provider owns storage, retrieval,
ranking, extraction, formatting, retention, and its model-facing operations. A
hosted semantic service and a bounded text file implement the same provider
contract without sharing a storage model.

## Public API at a glance

| Import path              | Public surface                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `eve/memory`             | `defineMemory`, `defineMemoryProvider`, `defaultNamespace`, provider contexts, scope types, and recall types |
| `eve/memory/scope`       | `byPrincipal`                                                                                                |
| `eve/memory/file`        | `fileMemory`, `inMemory`, and the portable document backend contract                                         |
| `eve/memory/file/vercel` | `vercelBlob`                                                                                                 |

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
scope, an optional eve-owned visibility policy, and an optional switch that
suppresses provider tools:

```ts title="agent/memory/user.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { customMemory } from "../lib/custom-memory";

export default defineMemory({
  description: "Personal preferences and durable facts for the authenticated user.",
  provider: customMemory,
  namespace: (ctx) => `${defaultNamespace(ctx)}:${process.env.DEPLOYMENT_REGION ?? "local"}`,
  scope: byPrincipal,
});
```

The same provider instance may back several slots. Their recalled context,
tools, and provider invocations remain independent. The default namespace
includes the slot identity, so each slot receives a distinct provider scope
key. Definitions that resolve the same custom namespace and scope intentionally
share a scope key.

A read-only slot sets `tools: false`. The provider's `tools` method is not
invoked and the slot exposes no model tools, while recall and capture continue
to run:

```ts title="agent/memory/policies.ts"
import { defineMemory } from "eve/memory";
import { policyMemory } from "../lib/policy-memory";

export default defineMemory({
  provider: policyMemory,
  scope: "workspace",
  tools: false,
});
```

`tools: false` is the only memory-specific tool control. Finer policy — per-tool
approval, overrides, or denial — reuses the ordinary dynamic-tool approval
surface, because provider tools are ordinary dynamic tools.

## Model-facing description

`description` is an optional static description of the slot's purpose:

```ts
interface MemoryDefinition {
  readonly description?: string;
  readonly namespace?: MemoryNamespaceDefinition;
  readonly provider: MemoryProvider;
  readonly scope: MemoryScopeDefinition;
  readonly tools?: boolean;
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
purpose before the provider's generic save-tool guidance. eve performs this
composition after the `tools` resolver returns and before the dynamic tool
metadata is captured, so every model step and parked continuation sees the same
description. Omitting `description` preserves each provider tool description
unchanged. An empty or whitespace-only description is invalid; authors omit the
field when no slot-specific purpose is needed.

The description is trusted application-authored model guidance. eve does not
derive it from the slot name, namespace, scope, or request context, and does not
expose those values through it. The description is not added to recalled
context or the prompt separately, so a provider without tools does not expose
it to the model. It helps the model choose among qualified tools but does not
enforce authorization or replace scope isolation.

## Namespace

Namespace identifies the application-owned memory domain. It may be a string,
`null`, or a resolver:

```ts
interface MemoryNamespaceContext {
  /** Absolute application root, used only for local namespace derivation. */
  readonly appRoot: string;
  /** Graph node that owns the slot. */
  readonly node: string;
  /** Path-derived slot identity, such as "memory" or "user". */
  readonly slot: string;
}

type MemoryNamespaceDefinition =
  string | null | ((context: MemoryNamespaceContext) => string | null | Promise<string | null>);

function defaultNamespace(context: MemoryNamespaceContext): string;
```

After resolving a non-null scope, eve invokes the namespace resolver when it
locks memory for a lifecycle operation. A resolved `null` disables the slot for
that operation. If `namespace` is omitted, eve uses the exported
`defaultNamespace` function as the resolver. `defaultNamespace` is a pure
function of its context and the deployment environment, so a custom resolver
composes with it:

```ts
namespace: (ctx) => `${defaultNamespace(ctx)}:${process.env.DEPLOYMENT_REGION ?? "local"}`,
```

The default policy separates deployment classes deliberately:

- **Production** combines the Vercel project, the stable target environment,
  the graph node, and the slot. Redeployments keep the same namespace.
- **Preview** additionally includes the deployment's branch or deployment
  identity, so unrelated Preview deployments in one project never share memory
  by accident. Redeployments of the same branch keep that branch's namespace.
- **Local development** combines a digest of the application root with the node
  and slot. The raw filesystem path is never persisted.

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
  | ((
      context: MemoryScopeContext,
    ) => MemoryScopeResolverResult | Promise<MemoryScopeResolverResult>);
```

`eve/memory/scope` exports the built-in principal resolver:

```ts
function byPrincipal(context: MemoryScopeContext): string | null;
```

Scope must come from authenticated session context, application data, or trusted
channel state. Scope is an authorization partition, not a model-selected
routing hint: the resolver context deliberately excludes messages, user-authored
turn input, and unprojected durable history. eve resolves scope before
namespace. A `null` scope disables the slot without invoking its namespace
resolver. Otherwise eve resolves the namespace. A `null` namespace also disables
the slot. A disabled slot does not call the provider, expose its tools, or
include its recalled context in the model request.

For an active slot, eve validates both values and derives the provider scope key
from exactly the resolved namespace and scope:

```ts
interface MemoryScope {
  /** Opaque scope key: a versioned digest of the canonical namespace and scope encodings. */
  readonly key: string;
  /** Resolved application-owned memory domain. */
  readonly namespace: string;
  /** Resolved scope exactly as the resolver returned it: a scalar or a tuple. */
  readonly value: string | readonly string[];
}
```

### Scope-key encoding

The namespace-plus-scope pair is the slot's scope key, and it is
collision-free by construction. eve never flattens a tuple with a delimiter.
Each input is canonically encoded with a versioned, type-tagged,
length-prefixed UTF-8 representation that distinguishes a scalar from a
one-element tuple, preserves tuple boundaries, and is safe for
delimiter-containing component values. Each encoding is hashed with SHA-256 and
emitted as a typed base64url key (`memns1_…` for namespaces, `memscope1_…` for
scopes). The provider-facing composite `scope.key` is derived from a versioned
encoding of those two opaque keys. Provider item IDs receive the same treatment
(`memitem1_…`) before they enter durable attribution.

Scalar `"a:b:c"`, tuple `["a:b", "c"]`, tuple `["a", "b:c"]`, and scalar `"a"`
versus tuple `["a"]` all produce distinct keys. Durable attribution stores only
the opaque namespace, scope, and item keys — never raw principal, channel,
namespace, scope, or provider item-ID values.

Every `recall`, `capture`, and `tools` call receives this scope. Tools close
over the same locked scope, so the model never selects a different user,
tenant, or container. A conforming provider must apply `scope.key` to every
downstream read and write. eve cannot prevent faulty provider code from
discarding the supplied scope, but the public contract provides no unscoped
provider invocation path.

eve locks scope for the active turn, including model steps and durable approved
call continuations. A standalone manual compaction resolves and locks scope for
that operation. Every recalled record remains attributed to the slot, namespace
key, and scope key under which it was accepted.

Passing `byPrincipal` as the scope resolver identifies the authenticated caller
from principal type, authenticator, optional issuer, and principal ID. It is a
pure consumer of the supplied `MemoryScopeContext`; it does not read ambient or
private runtime state. The function returns `null` — disabling the slot — when
`auth.current` is `null`, for anonymous principals such as `none()` traffic,
and for runtime principals such as scheduled turns. Anonymous callers never
receive a memory scope, shared or otherwise. Local development authenticates
every request as the shared `local-dev` principal, so one development machine
resolves one scope.

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

The returned array is a three-component tuple. Components may contain any
characters, including delimiters, without colliding with another scope. Include
a thread or conversation identifier as another component when the provider's
data must not cross that boundary. Resolver output is evaluated once when eve
locks the operation's memory scopes, and every provider call and tool in that
operation uses the locked value.

### Disabled-slot diagnostics

A `null` scope or namespace silently disables a slot — no provider call, no
tools, no recalled context. Because `byPrincipal` returns `null` for anonymous
and runtime principals, disablement is a common and correct state. In
development mode, eve emits a diagnostic when a slot resolves disabled, naming
the slot and whether the scope or namespace resolver returned `null`, without
logging resolved values. Disablement is never an error.

## Recall visibility across scope changes

`visibility` is an eve-owned `defineMemory` option. It controls which
previously recalled records enter a model request when the slot resolves a
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

| Value               | Model context after a scope change                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `"scope"` (default) | Include recalled records whose slot, namespace key, and scope key match the active locks. Exclude records for earlier scopes. |
| `"session"`         | Require slot and namespace key to match, but keep records across scope-key changes within that namespace visible in place.    |

Namespace is always an isolation boundary. `"session"` intentionally retains
prior recall across scope-key changes within one namespace; it never exposes
recall from an earlier namespace. The default favors recalled-context isolation
over cache reuse when the authenticated participant changes.

For a Slack thread where one authenticated participant follows another,
`"scope"` removes the first participant's recalled memory before the second
participant's model call. `"session"` keeps both visible. The second mode is an
explicit cross-scope disclosure policy and is appropriate only when the session
participants form one trusted audience.

```text
durable: ... -> participant A memory -> participant A turn -> assistant -> participant B memory -> participant B turn
scope:   ... -> participant A turn -> assistant -> participant B memory -> participant B turn
session: ... -> participant A memory -> participant A turn -> assistant -> participant B memory -> participant B turn
```

This option never changes provider scope. `recall`, `capture`, and `tools`
still receive only the active turn's locked scope. The provider cannot select
the visibility mode. A `null` scope suppresses all recalled context belonging
to the slot in both modes.

Recall visibility changes only scope-attributed recall records in the model
request. It does not remove ordinary user, assistant, or tool messages from
durable history, and it cannot undo information an earlier assistant response
derived from memory. Applications that require hard isolation between
participants must use separate sessions. Provider tools that return memory
content place that content in ordinary tool history and therefore own the same
shared-session risk.

## Provider contract

`MemoryProvider` defines the operations available at memory lifecycle
boundaries. `recall` is required. `capture` and `tools` are optional.

```ts
import type { ModelMessage } from "ai";
import type { SessionContext } from "eve/context";
import type { DynamicResolveContext, ToolDefinition } from "eve/tools";

interface MemoryRecallMessage {
  /** Provider context recalled into durable model history as a user-role message. */
  readonly content: string;
  /**
   * Optional provider-owned item identity, unique within the slot, namespace,
   * and scope. A keyed message inserts or replaces its item; an unkeyed
   * message appends immutably.
   */
  readonly id?: string;
}

type MemoryRecallResult = { readonly messages: readonly MemoryRecallMessage[] } | null | undefined;

/** Mirrors the ambient `ctx.session.turn` coordinates plus the turn input. */
interface MemoryTurnContext {
  /** Stable turn ID, matching `ctx.session.turn.id`. */
  readonly id: string;
  /** Zero-based durable turn sequence. The first turn is sequence 0. */
  readonly sequence: number;
  /** Normalized model messages accepted as input for this turn. */
  readonly input: readonly ModelMessage[];
}

interface MemoryOperationContext extends SessionContext {
  readonly abortSignal: AbortSignal;
  /** Projected model history at this lifecycle boundary, including visible recalled context. */
  readonly messages: readonly ModelMessage[];
  /** Identifies one logical recall or capture operation across workflow replay. */
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

type MemoryCaptureContext = MemoryOperationContext &
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

type MemoryToolSet = Readonly<Record<string, ToolDefinition>>;

interface MemoryProvider {
  recall(context: MemoryRecallContext): MemoryRecallResult | Promise<MemoryRecallResult>;

  capture?(context: MemoryCaptureContext): void | Promise<void>;

  tools?(context: MemoryToolsContext): MemoryToolSet | null | Promise<MemoryToolSet | null>;
}
```

Recalled context is always user-role. Recall is framework context appended
after the durable prefix and before the admitted turn input, so it preserves
the prompt-cache prefix in the normal case. eve does not offer a system-role
recall option: system-role content is position-independent, so keyed
supersession cannot compose with it, and any change to it invalidates the
prompt cache from message zero. Standing system-role guidance derived from
runtime state belongs in `defineDynamic` instructions.

`defineMemoryProvider(...)` is an identity-with-types helper. It does not add
storage behavior.

## Recall messages

A recall result is a set of messages applied to the slot's recalled context,
not a replacement snapshot. The optional `id` on each message selects the
semantics:

| Message           | Effect                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ content, id }` | Insert or replace the one item identified by `id`. Identical content is a no-op; changed content supersedes the older version, which leaves model context. |
| `{ content }`     | Append one immutable, unkeyed record. It cannot be updated later.                                                                                          |

A result of `{ messages: [] }`, `null`, or `undefined` changes nothing at this
boundary. The semantics that hold at every boundary:

- **Recall is observational.** Providers must not use it for external
  mutations. eve makes the durable commit atomic, but it cannot roll back
  provider side effects.
- **Accumulation is the only mode.** An item missing from a later result
  remains visible. Missing top-k retrieval results never imply removal. A
  provider that wants content replaced returns the same `id` with new content.
- **Item identity is `(slot, namespaceKey, scopeKey, idKey)`**, where each key
  is an eve-owned opaque digest. The same provider `id` under two slots,
  namespaces, or scopes identifies two independent items; neither can update
  or reveal the other.
- **Unkeyed messages are never content-deduplicated.** A repeated identical
  unkeyed message adds a second copy. Content a provider might return again
  must be keyed.
- **Batches validate completely before applying.** Empty or blank content,
  empty or oversized IDs, duplicate IDs within one batch, and unknown message
  keys are rejected, and a rejected batch applies nothing. Message order
  within a batch is preserved.

For example, keyed retrieval results `[A, B]` followed by `[B, C]` leave `A`,
`B`, and `C` visible, with `B` present once.

### Example: append-only event log

A principal-scoped provider that surfaces each new observation exactly once
uses unkeyed messages and never needs identity. Because unkeyed messages are
never deduplicated, the provider consumes each note rather than re-reading the
latest state:

```ts
import { defineMemoryProvider } from "eve/memory";

const auditMemory = defineMemoryProvider({
  async recall(ctx) {
    if (ctx.phase !== "turn.started") return null;
    const note = await takeUnreadNote(ctx.memory.scope.key);
    return note === null ? null : { messages: [{ content: note }] };
  },
});
```

### Example: bounded sparse retrieval

A vector-retrieval provider returns a different top-k subset each turn.
Because accumulation is monotonic, an unbounded stream of new IDs would grow
context forever. Keying results by window position bounds the visible set by
construction: each recall reuses the same `k` identities, superseding the
previous occupant of each position:

```ts
import { defineMemoryProvider } from "eve/memory";

const retrievalMemory = defineMemoryProvider({
  async recall(ctx) {
    if (ctx.phase !== "turn.started") return null;
    const hits = await search(ctx.memory.scope.key, ctx.turn.input, { limit: 3 });
    return {
      messages: hits.map((hit, rank) => ({ id: `rank:${rank}`, content: hit.text })),
    };
  },
});
```

A provider that keys by document identity instead (`id: hit.documentId`) keeps
every previously recalled document visible until it overwrites that identity.
Both are valid; the provider chooses its window policy.

### Rejected and deferred alternatives

Two richer recall shapes were considered and cut:

- **A tagged change union with an explicit `retract`.** No current provider
  needs a keyed item to disappear rather than be replaced: `fileMemory()`
  supersedes its whole document, including an empty-state rendering when the
  last entry is removed, and bounded retrieval reuses window identities. If a
  provider later needs true keyed removal, a retract form is an additive
  extension, and dropping it now also drops the private tombstone
  representation that projection would otherwise have to hide.
- **A `coverage: "complete"` inventory flag**, from which eve synthesized
  retractions for omitted IDs. No first-party provider consumes it, and
  omission-means-deletion is the sharpest foot-gun in a sparse-retrieval API.
  An inventory result shape remains an additive extension if a real enumerable
  provider needs framework diffing.

The `{ messages }` wrapper leaves room for future result-level metadata
without a breaking change.

## Durable records and projection

Every accepted recall message becomes an internal durable record attributed
with the slot, opaque namespace key, opaque scope key, opaque item key for
keyed messages, operation ID, and batch position. Raw durable history is
storage-only. Every message-bearing consumer — providers, dynamic resolvers,
approval and tool contexts, token accounting, compaction, instrumentation
callbacks, and the model request — receives a view derived from one canonical
scope projection, never raw durable history.

Projection folds records per slot and identity:

- visible unkeyed records always remain, in position;
- only the latest version of each keyed identity is visible, in the position of
  its accepted batch; superseded versions are hidden;
- attribution is stripped before any authored callback, tool, or model
  boundary. There is no public accessor for recall attribution; providers use
  stable item IDs instead of scanning history.

Recalled context is not emitted as `message.received`; it is framework context
rather than new channel input.

### Cache consequences

New items append at the tail and preserve the existing prompt prefix. Repeated
identical keyed items change nothing. An explicit update must stop the model
from seeing the prior value, and filtering that older occurrence necessarily
invalidates the prompt cache from that point forward. This is a deliberate
trade: pure append-only recall is strictly better for prompt cache on updates,
because the old copy would keep its position — but it leaves the contradicted
copy model-visible, which makes updates and removals nondeterministic after
compaction. Keyed supersession spends a mutation-driven cache invalidation to
buy deterministic visibility; it is not cache-neutral, and it never substitutes
a natural-language correction while leaving the contradicted content visible.

Within one session, the model also sees the mutation narrative — the old
recalled copy, then the tool calls that changed storage. Keyed supersession
earns its complexity at the boundaries where that narrative dies: compaction
drops tool results first, so a stale recalled copy can outlive the story of its
own removal and be summarized as fact. Deterministic supersession, not model
competence, is the design driver.

## Lifecycle

### Turn-start recall

After eve admits and normalizes a new turn, it resolves each memory scope and,
for a non-null scope, its namespace. It then calls `recall` with
`phase: "turn.started"` for every active slot. The context contains the
zero-based turn sequence, stable turn ID, normalized input, and the projected
history before the turn, including prior visible recalled context.

Every active slot resolves independently against that same pre-recall view.
Each result is normalized and validated, and the whole turn-wide batch commits
atomically: one failing slot or one invalid batch applies nothing for any slot.
Accepted messages are applied in stable slot-path order, after the durable
prefix and before the admitted turn input, and the projected view is recomputed
before tools resolve and the model runs.

The first turn has `ctx.turn.sequence === 0`. A provider does not need to
deduplicate its own recall: returning the current state as keyed messages every
turn is the intended pattern, because identical keyed messages are no-ops. A
provider may still use the turn coordinates to recall only on the first turn,
or use the current input as a retrieval query on every turn.

### Compaction capture, canonicalization, and recall

Before automatic or manual compaction rewrites history, eve calls an
implemented `capture` method with `phase: "compaction.requested"`. The provider
receives the projected pre-rewrite history and the compaction model and usage
metadata. A provider may persist a checkpoint, extract facts the summary could
omit, or do nothing.

Compaction is the canonicalization boundary for memory records. Trusted
internal code partitions every attributed memory record — across every slot,
namespace, scope, and visibility mode — away from ordinary conversation, folds
keyed records to one live version or deletion tombstone per identity, and
retains every immutable unkeyed append with its attribution. The free-form
summary prompt is built from projected ordinary conversation only; no
attributed memory record of any kind enters it. Canonical private memory state
is reattached to the rewritten history, so items hidden from the currently
active scope survive another scope's compaction, and sparse retrieval stays
accumulative across compaction.

Because superseded versions and hidden scopes can grow while the visible
prompt stays constant, eve triggers canonicalization on raw attributed-record
growth independently of visible prompt size. If canonical memory state alone
exceeds its configured bound, compaction fails with an actionable error — and
the failure is recoverable by design: the next recall boundary still runs, so
providers can supersede their keyed items with smaller content, and the bound
is application-configurable. eve never silently summarizes, evicts, or
truncates provider items.

After a checkpoint is durably appended, eve calls `recall` with
`phase: "compaction.completed"`. The provider receives the settled
post-compaction projected history and may return fresh messages, applied
through the same atomic path. Identical retained items are no-ops. The call occurs
after every successful automatic or manual compaction, even when the provider
skipped ordinary turn-start recall.

Provider tools are not resolved during a standalone compaction because no model
call follows that boundary.

### Context clear

`context.cleared` rewrites history outside compaction. A clear wipes attributed
memory records together with the conversation: the cleared session starts with
no recalled context, and the next turn-start recall repopulates it from
provider storage through the normal path. Memory durability lives in provider
storage, not in session records, so a cleared conversation recalls current
memory exactly once, with no stale copies. This behavior requires a direct
test: clear, then assert the next turn recalls the provider's current state
exactly once.

### Turn tools

After turn-start recall settles, eve resolves `tools` once for the active turn
unless the definition sets `tools: false`. The function may be synchronous or
asynchronous. Its context contains the same session, authentication, channel,
and message fields as a `defineDynamic` resolver, plus the locked memory scope,
slot, and turn. Its messages include the projected turn-start recall results
followed by the admitted turn input. Returning `null` or an empty record
exposes no tools for the slot.

The memory definition is implicit `defineDynamic` authoring: eve adapts each
implemented `tools` function to a `turn.started` dynamic resolver. Provider
tools are ordinary branded `defineTool()` entries and depend entirely on the
generic dynamic-tool engine — durable callback descriptors that survive fresh
processes ([#2345](https://github.com/vercel/eve/issues/2345)), per-call
origins that resume against the originating definition
([#2346](https://github.com/vercel/eve/issues/2346)), and the runtime-tool
contribution seam ([#2347](https://github.com/vercel/eve/issues/2347)). Memory
adds no tool machinery of its own: no memory-specific approval methods, no
separate callback registry, and no `defineMemoryTool` wrapper.

Tools never write recalled context. A tool executor mutates provider storage
and returns ordinary tool output; recall is the single writer of recalled
context, and the consistency contract is that the next recall boundary reflects
storage.
Within the turn that mutated storage, the stale recalled item remains visible
and the model's own tool-call narrative covers the gap; the next turn-start or
post-compaction recall trues it up.

eve qualifies every returned key as `<slot>__<tool>` and binds the locked scope
to the tool implementation. Provider tools use the standard tool contract,
including input and output schemas, approval, authorization, and model-output
projection. In particular, `once()` approval is session-wide: approving one
qualified tool name also approves that name after a scope change. Providers
should use `always()` or a custom policy when approval must be participant- or
scope-specific.

The resolved tool set remains stable across every model step in the turn. When
a call parks on approval or authorization, the continuation reconstructs the
exact originating definition — including its captured scope — through the
generic durable-descriptor and call-origin machinery, even in a fresh process
and even if another participant has since replaced the current turn's tools.
Callback forms the descriptor mechanism cannot express fail with an explicit
diagnostic at resolution time rather than silently degrading at replay.

A direct inline-authorization park follows the ordinary tool contract. The
unfinished assistant/tool exchange does not enter durable history, and the
callback makes the credential available only to its matching principal. It does
not replay the original tool execution. A later model step uses the same
turn-scoped tool set.

Workflow replay returns recorded results for committed resolutions. Resolver
code may run again when an uncommitted delivery is re-executed after a crash,
so resolver side effects must be idempotent; provider mutations belong in the
returned tools' `execute` functions. eve never substitutes the current turn's
definition or scope for a parked call's captured definition.

### Completed-turn capture

After a turn reaches `turn.completed`, eve calls an implemented `capture`
method with `phase: "turn.completed"`. The provider receives the completed turn
input and the settled projected history, including the assistant response and
tool results. The method does not run for failed, cancelled, input-deferred, or
adapter-consumed turns.

Completed-turn capture is a semantic memory boundary, not an instrumentation
export. It does not receive token usage, provider cost, latency, trace
identifiers, or unsuccessful outcomes. A provider that also consumes
instrumentation can correlate the two surfaces with `ctx.session.id` and
`ctx.turn.id`. The `usageInputTokens` field on `compaction.requested` is
specific to that boundary because it describes the context about to be
compacted.

eve awaits completed-turn captures before emitting `session.waiting` in
conversation mode or `session.completed` in task mode. A provider may capture
the turn, update a remote profile, enqueue its own work, or do nothing.

## Replay and failures

Every recall and capture invocation receives an `operationId` for one logical
slot operation. eve reuses the ID across workflow replay, so it is not a unique
callback-attempt identifier. A provider must use it as the idempotency key for
externally visible `capture` side effects.

Recall operations for one session are serialized by construction: turn steps
serialize through workflow hook-ownership claims, so two recall operations for
the same slot, namespace, and scope cannot complete out of order. The message
shape is therefore revision-free. eve persists each operation's accepted
normalized batch, or its canonical digest, and a cold replay must reuse the
stored batch or match its digest exactly; a replay that returns a reordered or
changed batch for the same operation ID fails explicitly and mutates nothing.
Batch ordinals identify entries only within that fixed accepted batch.

Failure behavior follows the point at which the method runs:

- A turn-start `recall` failure fails the active turn before the model runs.
  Any slot failure or invalid batch applies nothing for the entire turn-wide
  recall batch.
- A `compaction.requested` capture failure aborts compaction before history
  changes.
- A post-compaction `recall` failure cannot undo the checkpoint. It fails the
  active turn when compaction was automatic; standalone compaction emits a
  diagnostic and returns the session to waiting.
- A throwing or invalid `tools` result is diagnosed and omitted for the turn,
  matching `defineDynamic` tool resolution.
- A completed-turn `capture` failure cannot rewrite the completed response. eve
  emits a content-free diagnostic and continues to the ready boundary.
- A `null` scope skips operations; it never falls back to a shared key.

## Limits

All limits reject invalid or oversized input with actionable errors. eve never
silently truncates or evicts. Values below are the proposal-review targets;
implementation uses exactly the reviewed constants.

| Constant                    | Value                                | Applies to                                               |
| --------------------------- | ------------------------------------ | -------------------------------------------------------- |
| Namespace                   | 1,024 UTF-8 bytes                    | resolved namespace value                                 |
| Scope component             | 1,024 UTF-8 bytes                    | each scalar or tuple component                           |
| Scope tuple                 | 16 components                        | resolver array results                                   |
| Canonical key input         | 4,096 UTF-8 bytes                    | total namespace-plus-scope encoding                      |
| Provider item ID            | non-empty, 1,024 UTF-8 bytes         | keyed message `id`                                       |
| Key prefixes                | `memns1_`, `memscope1_`, `memitem1_` | SHA-256 digests, base64url                               |
| Raw-record canonicalization | 512 records or 262,144 bytes         | superseded/hidden attributed records between compactions |
| Canonical private state     | 131,072 bytes, configurable          | folded memory state that must survive compaction         |
| File entry                  | 2,048 UTF-8 bytes                    | normalized `save_memory` text                            |
| File document               | 65,536 UTF-8 bytes                   | exact serialized stored document, including header       |
| File entries                | `maxEntries`, default 100            | live entries per scope key                               |

## Built-in file memory

`fileMemory()` is the reference bounded-document provider. It stores one
indexed `MEMORY.md`-style document per memory scope key.

```ts
interface FileMemoryOptions {
  readonly backend?: MemoryDocumentBackend;
  /** Defaults to 100. */
  readonly maxEntries?: number;
}

function fileMemory(options?: FileMemoryOptions): MemoryProvider;
```

### Recall: one whole-document keyed message

`recall` loads the current document at every turn start and after every
successful compaction, renders it — a heading that names the slot, explains the
indexed entries, and states the exact qualified removal tool name, followed by
each live `index: text` line — and returns exactly one keyed message under a
single stable provider ID. An unchanged document is an identical keyed message
and therefore a no-op; the provider never scans history. A mutated document
supersedes the previous copy, so a removed or edited entry deterministically
leaves model context at the next recall boundary, with no stale copy left
visible. A document whose last entry was removed renders an empty state — the
heading plus a line stating no memories are saved — so removal of the final
entry supersedes the old content the same way. A missing document, one never
created for this scope key, recalls nothing, so sessions that never save
memories carry no recalled context.

Whole-document granularity is a provider choice, not an API requirement: each
mutation re-sends the document and invalidates the cache from the document's
previous position, while non-mutation turns cost nothing. Per-entry keyed
messages remain a legal finer-grained alternative for providers whose removals
can supersede per item.

### Tools

`tools` exposes `save_memory({ text })` and `remove_memory({ index })`. Each
tool completes after its conditional write and returns no output; the next
recall reflects the updated document. `save_memory` normalizes whitespace,
treats duplicate text as a successful no-op, and fails when the document
reaches `maxEntries`. `remove_memory` is a no-op when its index is absent. The
provider omits `capture`: it does not run an extraction model or persist whole
conversations.

### Storage format

The stored document has a versioned header that persists `lastAllocatedIndex`
(starting at `-1`) alongside the live indexed lines. Indexes are allocated
monotonically and never renumbered or reused, including after the highest live
index is removed, so a model-facing index from earlier context can never alias
a different, later fact. `maxEntries` counts live entries, so removal frees
capacity without resetting the high-water mark. When `lastAllocatedIndex`
reaches `Number.MAX_SAFE_INTEGER`, the next save fails explicitly. Removal
visibility comes from the changed document superseding the previous copy, so
the document needs no deletion tombstones. Header bytes count toward the
document limit.

### Backend contract and selection

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

Every backend implements the same optimistic read/replace contract. The default
backend fails closed and resolves lazily on first storage access:

| Environment                                                       | Default backend                         |
| ----------------------------------------------------------------- | --------------------------------------- |
| Vercel with Blob credentials (token, or attached store with OIDC) | Private Vercel Blob                     |
| Vercel without Blob configuration                                 | Error: attach a store or pass a backend |
| eve development environment (`eve dev`)                           | Shared process-local in-memory backend  |
| Every other environment, including unset or unknown `NODE_ENV`    | Error: explicit backend required        |

Vercel detection takes precedence over development flags, a Blob token outside
Vercel never silently selects Blob, and `NODE_ENV` alone never proves a
development environment. An explicit `fileMemory({ backend })` is used in every
environment. Tests pass `inMemory()` explicitly.

The same lifecycle also supports a hosted semantic provider:

| Boundary               | Bounded file provider       | Hosted semantic provider                     |
| ---------------------- | --------------------------- | -------------------------------------------- |
| `turn.started` recall  | Recall the current document | Recall keyed retrieval results for the input |
| Post-compaction recall | Recall if context is absent | Refresh against the compacted history        |
| Pre-compaction capture | Omit                        | Preserve facts or checkpoint provider state  |
| Completed-turn capture | Omit                        | Capture the completed interaction            |
| Turn tools             | Save and remove entries     | Provider-defined search, save, or forget     |

At each boundary, a provider may return `undefined` from `recall`, omit or do
nothing in `capture`, or return `null` from `tools`.

## Provider packaging

A provider package exports a `MemoryProvider` or provider factory. It may own
credentials, remote APIs, migrations, retrieval, capture, and model tools. The
consuming agent owns the slot path, namespace, scope, tool suppression, and
recall visibility. Mounted extensions cannot contribute memory slots.

## Design invariants

- A slot is active only when both namespace and scope resolve to non-empty
  values. Omitting `namespace` selects `defaultNamespace`; `null` disables the
  slot, with a development-mode diagnostic and never an error.
- The resolved namespace and scope are the only variable inputs to the provider
  key, canonically encoded and digested so scalars, tuples, and
  delimiter-containing values cannot collide. Custom namespaces receive no path
  or deployment suffixes.
- One scope lock applies to every provider call, recalled record, model step,
  and durable tool continuation in an operation.
- Recall and capture phases identify their exact lifecycle boundary. Every
  provider context includes projected history and a replay-stable operation ID.
- Raw durable history is storage-only. Every message-bearing consumer receives
  one canonical scope projection with attribution stripped; no authored
  callback or model boundary sees hidden items or eve-owned metadata.
- A recall result is a validated batch of recalled messages, committed
  atomically per turn across all active slots. Omission never removes; unkeyed
  messages are immutable; an identical keyed message is a no-op; a changed
  keyed message supersedes only its own prior version.
- Item identity is `(slot, namespaceKey, scopeKey, idKey)`. The same provider
  ID under different locks is a different item.
- `visibility` controls which attributed records enter a model request after a
  scope-key change within one namespace. Namespace is always an isolation
  boundary.
- Compaction canonicalizes memory records without laundering any attributed
  record into a free-form summary and without dropping items hidden from the
  active scope. Canonical-state overflow fails recoverably: recall still runs
  so providers can supersede keyed items with smaller content.
- Provider tools are slot-qualified, scope-bound ordinary dynamic tools built
  entirely on the generic dynamic-tool engine. Each turn resolves one complete
  tool set, every model step uses it, and a durable call keeps its originating
  definition until settlement. Tools never write recalled context.
- An optional static slot description is prepended to every provider tool
  description before durable metadata capture. It never derives from or exposes
  the namespace or scope, and it guides model routing without granting access.
- Completed-turn capture settles before the next ready boundary.

## Non-goals

One earlier non-goal is explicitly reversed: this proposal gives eve a
projection record model — item identity and supersession semantics for
recalled context. eve owns how recalled items appear and update in model
context. eve still owns no storage model: what a provider persists, how it
ranks, embeds, extracts, or retains data remains entirely provider-defined.

Still out of scope:

- Framework-provided remember, forget, purge, export, or administrative APIs.
  Supersession changes model-visible context; it is not a storage-erasure
  guarantee, and storage erasure remains a provider operation.
- A built-in capture model, extractor, formatter, retention policy, or erasure
  guarantee.
- A memory-specific observability feed for usage, cost, latency, traces,
  errors, or cancelled turns.
- Cross-provider search, mutation, or record reconciliation.
- Model-selected alternate scopes or unscoped provider invocations.
- Treating recall visibility as complete participant isolation for ordinary
  conversation messages or provider tool results.
- Preventing faulty or malicious provider code from ignoring the supplied
  scope.
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
      Resolver arrays are canonically encoded as collision-free tuples, while
      `null` preserves slot disablement. The authoring guidance states that
      principal scope crosses channels and shows how to add team, channel, and
      conversation coordinates for private memory. This resolves the [scope and
      Slack privacy
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807248748).

- [x] **Keep settled-turn telemetry out of memory.** `capture` with
      `phase: "turn.completed"` receives completed input and projected history,
      but not usage, cost, latency, trace identifiers, or unsuccessful
      outcomes. Instrumentation owns that data and can be correlated through
      `session.id` plus `turn.id`. `compaction.requested` retains its input-token
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

- [x] **Define recall placement and tool invocation semantics.** A recall
      result is a validated batch of recalled messages applied atomically at
      its lifecycle boundary as user-role context; a keyed message supersedes
      its prior version. `null`, `undefined`, empty batches, and normalized
      empty content change nothing and never clear earlier history; omission
      never removes. Session
      visibility retains records across scope-key changes within one namespace;
      scope visibility filters earlier scopes. eve invokes `recall`
      deterministically and resolves one tool set per turn, while the model
      decides whether to call an exposed tool. This resolves the
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
      `ctx.messages` is the projected history at each boundary, and framework
      identity deduplication replaces provider-side history scanning — there is
      no public attribution accessor. The namespace/scope split, lifecycle
      phases, telemetry boundary, and cross-provider behavior match the
      intended implementation. All outdated, approval-only, and superseded
      threads are resolved, including the
      [cross-provider
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3807280622)
      and the [outdated turn-input
      thread](https://github.com/vercel/eve/pull/1581#discussion_r3772094622).
