---
issue: https://github.com/vercel/eve/issues/1510
status: proposed
last_updated: "2026-08-14"
---

# First-class memory

## Proposal

Memory is a path-authored capability for scoped context that outlives one
session. A memory provider owns how it stores, retrieves, and updates memory.
eve owns when the provider participates in the agent lifecycle.

The provider contract has three semantic methods:

- `recall` updates the context projected into model calls.
- `save` observes history before compaction and after a completed turn.
- `tools` contributes model tools bound to the active memory scope.

These methods replace a generic map of lifecycle event handlers. eve calls each
method at fixed boundaries and supplies a discriminated `phase`, the current
turn coordinates, a stable operation ID, and the scope resolved for the slot.
The provider may vary its behavior by phase or turn. For example, a provider can
recall on turn sequence `0`, keep that projection across later turns, and
refresh it after compaction.

```text
turn.started          ---> recall(phase: "turn.started")
compaction.requested  ---> save(phase: "compaction.requested")
compaction.completed  ---> recall(phase: "compaction.completed")
step.started          ---> tools(phase: "step.started")
turn.completed        ---> save(phase: "turn.completed")
```

eve owns path-derived identity, trusted scope resolution, invocation order,
scope-bound context projection, projection visibility, tool qualification, and
replay behavior. The provider owns storage, retrieval, ranking, extraction,
formatting, retention, and its model-facing operations. A hosted semantic
service and a bounded text file can therefore use the same slot without sharing
a record or storage model. An ordinary extension can call either store, but it
cannot provide these scope-locked lifecycle and projection guarantees without
recreating memory inside the runtime. Those guarantees justify the dedicated
slot.

## Public API at a glance

| Import path              | Public surface                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `eve/memory`             | `defineMemory`, `defineMemoryProvider`, `byPrincipal`, provider contexts, scope types, and projection types |
| `eve/memory/file`        | `fileMemory`, `inMemory`, and the portable document backend contract                                        |
| `eve/memory/file/vercel` | `vercelBlob`                                                                                                |

The smallest complete memory slot uses the built-in file provider:

```ts title="agent/memory/user.ts"
import { byPrincipal, defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  provider: fileMemory(),
  scope: byPrincipal(),
});
```

For `agent/memory/user.ts`, eve derives the slot name `user`. Provider tools are
qualified with that identity, such as `user__save_memory` and
`user__remove_memory`.

## Authoring experience

An agent may declare one flat slot or a directory of named slots:

```text
agent/memory.ts            # one slot named "memory"
agent/memory/              # XOR with the flat file
  user.ts                  # slot named "user"
  workspace.ts             # slot named "workspace"
```

Each module default-exports `defineMemory(...)`. The definition contains the
provider, the trusted scope resolver, and optional eve-owned projection policy:

```ts title="agent/memory/user.ts"
import { defineMemory } from "eve/memory";
import { customMemory } from "../lib/custom-memory";
import { resolveWorkspaceId } from "../lib/workspaces";

export default defineMemory({
  provider: customMemory,
  async scope(ctx) {
    const principal = ctx.session.auth.current;
    if (principal === null) return null;

    const workspaceId = await resolveWorkspaceId(principal, {
      signal: ctx.abortSignal,
    });
    return workspaceId === null ? null : [workspaceId, principal.principalId];
  },
});
```

The same provider instance may back several slots. Their path identities,
scopes, projections, tools, and provider invocations remain independent.

## Scope

Scope is the required addressing contract between an agent and a provider. A
scope resolver returns an ordered tuple of trusted identifiers or `null`:

```ts
interface MemoryScopeContext extends SessionContext {
  readonly abortSignal: AbortSignal;
}

type MemoryScopeDefinition = (
  context: MemoryScopeContext,
) => readonly string[] | null | Promise<readonly string[] | null>;
```

Scope parts must come from authenticated session context, application data, or
trusted channel state. They never come from model input. Returning `null`
disables the slot for the active turn or standalone compaction; eve does not
call the provider, expose its tools, or include any of its projections in model
context.

eve turns the authored tuple into a provider scope:

```ts
interface MemoryScope {
  /** Stable eve namespace derived from the app, environment, graph node, slot, and parts. */
  readonly key: string;
  /** Ordered identifiers returned by the authored resolver. */
  readonly parts: readonly string[];
}
```

Every `recall`, `save`, and `tools` call receives this scope. Tools close over
the same locked scope, so the model never selects a different user, tenant, or
container. A conforming provider must apply `scope.key` or `scope.parts` to
every downstream read and write. eve cannot prevent faulty provider code from
discarding the supplied scope, but the public contract provides no unscoped
provider invocation path.

eve locks scope for the active turn, including model steps and durable approved
call continuations. A standalone manual compaction resolves and locks scope for
that operation.
Every projection remains attributed to the slot and scope key under which it
was recalled.

`byPrincipal()` scopes a slot to the authenticated caller and disables it for an
unauthenticated caller. It includes the principal type, authenticator, optional
issuer, and principal ID in the returned tuple.

## Projection visibility across scope changes

`visibility` is an eve-owned `defineMemory` option. It controls which
previously recalled projections enter a model request when the slot resolves a
different scope. The option belongs to the consuming memory definition rather
than the provider because eve owns prompt assembly and the application owns the
session's audience boundary:

```ts title="agent/memory/user.ts"
import { byPrincipal, defineMemory } from "eve/memory";
import { customMemory } from "../lib/custom-memory";

export default defineMemory({
  provider: customMemory,
  scope: byPrincipal(),
  visibility: "session",
});
```

```ts
type MemoryVisibility = "scope" | "session";
```

| Value               | Model context after a scope change                                                                                                          | Prompt cache                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `"scope"` (default) | Include only the projection whose scope key matches the active turn. Exclude projections recalled for earlier participants.                 | Filtering an earlier projection changes the existing prefix and invalidates the affected cache.       |
| `"session"`         | Keep projections recalled for earlier scopes visible, then add the active scope's first projection immediately before its first turn input. | The scope change alone preserves the prior prefix; replacing or clearing a projection may still bust. |

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

`MemoryProvider` describes memory behavior rather than exposing the complete
hook lifecycle. `recall` is required. `save` and `tools` are optional.

```ts
import type { ModelMessage } from "ai";
import type { SessionContext } from "eve/context";
import type { ToolDefinition } from "eve/tools";

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
  /** Identifies one logical slot operation and may repeat across replay or reconstruction. */
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

type MemoryToolsContext = MemoryOperationContext & {
  readonly phase: "step.started";
  readonly turn: MemoryTurnContext;
  readonly step: {
    readonly stepIndex: number;
    readonly modelId: string;
  };
};

type MemoryRecallResult = MemoryProjection | null | undefined;
type MemoryToolSet = Readonly<Record<string, ToolDefinition>>;

interface MemoryProvider {
  recall(context: MemoryRecallContext): MemoryRecallResult | Promise<MemoryRecallResult>;

  save?(context: MemorySaveContext): void | Promise<void>;

  tools?(context: MemoryToolsContext): MemoryToolSet | null | Promise<MemoryToolSet | null>;
}
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

## Reference provider shape

This provider recalls once for each scope that enters the session, refreshes
after compaction, saves pre-compaction and completed-turn views through
different service operations, and exposes one scope-bound tool:

```ts title="agent/lib/provider.ts"
import { defineMemoryProvider } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { service } from "./service";

export const provider = defineMemoryProvider({
  async recall(ctx) {
    if (ctx.phase === "turn.started" && ctx.turn.sequence > 0 && ctx.memory.current !== null) {
      return;
    }

    const content = await service.recall({
      history: ctx.messages,
      input: ctx.turn?.input ?? [],
      scope: ctx.memory.scope,
      signal: ctx.abortSignal,
    });
    return content === null || content.length === 0 ? null : { content };
  },

  async save(ctx) {
    if (ctx.phase === "compaction.requested") {
      await service.checkpoint({
        history: ctx.messages,
        operationId: ctx.operationId,
        scope: ctx.memory.scope,
        signal: ctx.abortSignal,
      });
      return;
    }

    await service.capture({
      history: ctx.messages,
      operationId: ctx.operationId,
      scope: ctx.memory.scope,
      signal: ctx.abortSignal,
      turn: ctx.turn,
    });
  },

  tools(ctx) {
    const scope = ctx.memory.scope;
    return {
      forget: defineTool({
        description: "Forget one saved memory.",
        inputSchema: z.object({ id: z.string() }),
        execute: ({ id }) => service.forget({ id, scope }),
      }),
    };
  },
});
```

The provider receives the same scope in all three methods. The `forget` tool is
exposed as `<slot>__forget`; for a slot named `user`, its model-facing name is
`user__forget`.

## Memory projection

Each slot stores at most one projection for every scope key it encounters in a
session. The durable projection state includes the slot, scope key, content, and
prompt anchor. `ctx.memory.current` exposes only the projection belonging to the
active scope.

The first valid projection for a scope anchors one synthetic user-role
message immediately before that scope's current turn input. A later
`{ content }` result replaces the projection at the same anchor, `null` removes
it, and `undefined` leaves it unchanged. Replacing, clearing, or filtering an
already anchored projection changes the earlier prompt prefix and may invalidate
the provider prompt cache.

At model assembly, eve applies the slot's `visibility`. `"scope"` includes only
projections matching the active scope. `"session"` includes all of the slot's
projections in anchor order. Projections created at the same boundary use stable
slot-path order. This is the framework behavior a provider or ordinary
extension cannot reproduce from an untagged user message.

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

This differs from user-role instructions. A user-role instruction appends
application context to durable conversation history at its lifecycle boundary.
A memory projection is replaceable, scope-bound provider context kept outside
that history.

## Lifecycle

### Turn-start recall

After eve admits and normalizes a new turn, it resolves each memory scope and
calls `recall` with `phase: "turn.started"`. The context contains the zero-based
turn sequence, stable turn ID, current input, prior durable history, and current
projection for the active scope.

`phase` names the lifecycle boundary; provider methods are framework calls, not
hook subscribers. Turn-start recall therefore receives normalized input even
though existing public stream events keep their current emission order.

The first turn has `ctx.turn.sequence === 0`. A provider may use that coordinate
to recall only on the first turn. A provider that wants one recall per scope can
also recall whenever `ctx.memory.current === null`, including when a new
participant changes the scope on a later turn. A semantic provider may recall
on every turn using the current input as its query.

The result is ready before the first model call. If automatic compaction runs at
the same opening boundary, the projection remains outside compaction input and
the post-compaction recall may replace it before the model runs.

### Compaction save and recall

Before automatic or manual compaction rewrites history, eve calls `save` with
`phase: "compaction.requested"`. The provider receives the complete durable
history about to be compacted, the active projection separately as
`ctx.memory.current`, and the compaction model and usage metadata. A provider may
persist a checkpoint, extract facts the summary could omit, or do nothing.

After a checkpoint is durably appended, eve calls `recall` with
`phase: "compaction.completed"`. The provider receives the settled
post-compaction history and can replace, clear, or preserve its current
projection. The call occurs after every successful automatic or manual
compaction, even when the provider skipped ordinary turn-start recall. Only the
active scope's projection can change during this call; visibility of other
projections remains eve-owned policy.

Provider tools are not resolved during a standalone compaction because no model
call follows that boundary.

### Step tools

Before each model step, eve calls `tools` with `phase: "step.started"`. For an
ordinary step, that result replaces the slot's prior tool set rather than
merging with it. Returning `null` or an empty record exposes no new tools for
that slot and step.

eve qualifies every returned key as `<slot>__<tool>` and binds the locked scope
to the tool implementation. Provider tools otherwise use the ordinary tool
contract, including input and output schemas, approval, authorization, and
model-output projection. In particular, `once()` approval remains session-wide:
approving one qualified tool name also approves that name after a scope change.
Providers should use `always()` or a custom policy when approval must be
participant- or scope-specific.

A call that parks for approval is an exception to ordinary replacement. eve
reconstructs it by calling `tools` again with the captured originating context
and the same `operationId`. That definition handles the approved call even when
the current step exposes no new tools; the latest ordinary result still handles
unrelated new calls. The same reconstruction applies if that durable historical
call later parks for authorization.

A direct inline-authorization park follows the ordinary tool contract. The
unfinished assistant/tool exchange does not enter durable history, and the
callback makes the credential available only to its matching principal. It does
not replay the original tool execution. A later model step resolves the latest
tool set under its current turn and receives a new `operationId`.

Any tool key that can remain parked must stay present with compatible input and
output schemas until its calls settle. The same logical tool operation may be
resolved more than once, so `tools` must be deterministic and side-effect-free.
Provider mutations belong in the returned tool's `execute` function. A missing
parked key fails the continuation instead of changing its scope or definition.

### Completed-turn save

After a turn reaches `turn.completed`, eve calls `save` with
`phase: "turn.completed"`. The provider receives the completed turn input and
the settled durable history, including the assistant response and tool results.
The method does not run for failed, cancelled, input-deferred, or
adapter-consumed turns.

eve awaits completed-turn saves before emitting `session.waiting` in
conversation mode or `session.completed` in task mode. A provider may capture
the turn, update a remote profile, enqueue its own work, or do nothing.

## Replay and failures

Every provider invocation receives an `operationId` for one logical slot
operation. eve reuses the ID across workflow replay and when it reconstructs a
parked tool, so it is not a unique callback-attempt identifier. A provider must
use it as the idempotency key for externally visible `save` side effects. eve
records recall results, scope attribution, and prompt anchors in durable session
state.

Failure behavior follows the point at which the method runs:

- A turn-start `recall` failure fails the active turn before the model runs.
- A `compaction.requested` save failure aborts compaction before history changes.
- A post-compaction `recall` failure cannot undo the checkpoint. It fails the
  active turn when compaction was automatic; standalone compaction emits a
  diagnostic and returns the session to waiting.
- A `tools` failure fails the model step rather than silently changing the
  available memory operations.
- A completed-turn `save` failure cannot rewrite the completed response. eve
  emits a content-free diagnostic and continues to the ready boundary.

## Built-in file memory

`fileMemory()` is the reference bounded-document provider. It stores one indexed
`MEMORY.md`-style document per scope.

Its `recall` method loads the current document at every turn start and after
every successful compaction. Its `tools` method exposes
`save_memory({ text })` and `remove_memory({ index })`. A mutation is reflected
immediately in the tool result and in the projection recalled on the next turn.
It omits `save`: the provider does not run a hidden capture model or persist
whole conversations.

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

Process-local memory supports tests and development. Vercel Blob provides the
hosted backend. Other stores can implement the same optimistic read/replace
contract without becoming part of eve's memory model.

The same lifecycle also supports a hosted semantic provider:

| Boundary               | Bounded file provider       | Hosted semantic provider                    |
| ---------------------- | --------------------------- | ------------------------------------------- |
| `turn.started` recall  | Load the current document   | Retrieve against the current turn input     |
| Post-compaction recall | Reload the current document | Refresh against the compacted history       |
| Pre-compaction save    | Omit                        | Preserve facts or checkpoint provider state |
| Completed-turn save    | Omit                        | Capture the completed interaction           |
| Step tools             | Save and remove entries     | Provider-defined search, save, or forget    |

These are provider choices, not additional framework modes. A provider may
skip a phase by returning `undefined` from `recall`, doing nothing in `save`, or
returning `null` from `tools`.

## Provider packaging

A provider package exports a `MemoryProvider` or provider factory. It may own
credentials, remote APIs, migrations, retrieval, capture, and model tools. The
consuming agent still owns the slot path, scope resolver, and projection
visibility. Mounting an extension cannot contribute a memory slot without an
explicit consumer-owned scope and visibility policy.

## Observable guarantees

- Every memory slot has path-derived identity and an explicit trusted scope.
- Projection visibility defaults to the active scope. Session-wide visibility
  is an explicit `defineMemory` option.
- `recall`, `save`, and `tools` always receive the same locked scope for one
  lifecycle operation.
- Recall phases distinguish ordinary turn start from post-compaction refresh.
- Save phases distinguish pre-compaction preservation from completed-turn
  capture.
- Providers receive zero-based turn sequence, stable turn ID, normalized turn
  input, durable history, current projection, and a replay-stable operation ID.
- A recall result replaces, clears, or preserves the active scope's projection
  without changing another scope's projection.
- An empty projection is invalid; clearing and preserving require `null` and
  `undefined`, respectively.
- Projections enter model calls as user-role context but remain outside durable
  conversation history and compaction input.
- Scope visibility filters earlier projections and may bust the prompt cache;
  session visibility retains them in anchor order and intentionally shares
  their content across scope boundaries.
- Provider tools are unconditionally slot-qualified and scope-bound. Ordinary
  step results replace the prior set, while durable approved calls retain their
  originating definition until settlement.
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
