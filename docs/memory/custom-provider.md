---
title: "Build a Memory Provider"
description: "Implement the recall, capture, and tools contract so any store or memory service can back an eve memory slot."
---

A memory provider is an object with a `recall` handler and optional `capture`
and `tools` handlers. eve calls those handlers at fixed points in the agent
lifecycle and passes each one a locked scope key, the projected conversation,
and a stable operation ID. Anything that can read and write under that key can
be a provider. Package one as a library that exports a provider factory, or
write one directly inside an agent.

```ts title="agent/lib/notes-memory.ts"
import { defineMemoryProvider } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { notes } from "./notes-db";

export function notesMemory() {
  return defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        const rows = await notes.search({
          partition: ctx.memory.scope.key,
          query: ctx.turn.input,
          limit: 5,
        });
        return {
          messages: rows.map((row) => ({ id: row.id, content: row.text })),
        };
      },
    },
    capture: {
      async "turn.completed"(ctx) {
        await notes.ingest({
          partition: ctx.memory.scope.key,
          idempotencyKey: ctx.operationId,
          messages: ctx.messages,
        });
      },
    },
    async tools(ctx) {
      return {
        forget: defineTool({
          description: "Delete a remembered note by its ID.",
          inputSchema: z.object({ id: z.string() }),
          async execute({ id }) {
            await notes.delete({ partition: ctx.memory.scope.key, id });
            return { deleted: true };
          },
        }),
      };
    },
  });
}
```

Bind the provider to a slot like any other:

```ts title="agent/memory/notes.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { notesMemory } from "../lib/notes-memory";

export default defineMemory({
  description: "Notes the caller has asked the agent to remember.",
  provider: notesMemory(),
  scope: byPrincipal,
});
```

The model sees the tool as `notes__forget`, and the slot description is
prepended to its description.

## The provider contract

`defineMemoryProvider()` accepts three surfaces. Omit any handler the provider
does not need; `fileMemory()`, for example, implements recall and tools but no
capture.

| Surface   | Handlers                                              | Responsibility                                           |
| --------- | ----------------------------------------------------- | -------------------------------------------------------- |
| `recall`  | `"turn.started"` (required), `"compaction.completed"` | Return messages to place in model context                |
| `capture` | `"turn.completed"`, `"compaction.requested"`          | Observe settled history and write to the store           |
| `tools`   | one function                                          | Return model-facing operations bound to the locked scope |

### Operation context

Every handler receives a `MemoryOperationContext`:

| Field                    | Meaning                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `memory.scope.key`       | Opaque, versioned digest of the namespace and scope. Use it as the partition key for every read and write. |
| `memory.scope.namespace` | The resolved namespace string                                                                              |
| `memory.scope.value`     | The resolved scope string or tuple                                                                         |
| `memory.slot`            | The path-derived slot name                                                                                 |
| `messages`               | Projected conversation history for this phase                                                              |
| `operationId`            | Stable per session, sequence, phase, and slot. Use it to make external side effects idempotent.            |
| `abortSignal`            | Cancellation for the operation                                                                             |
| `session`                | Session ID, authentication, and other `SessionContext` fields                                              |

Phase-specific fields:

- `turn.started` and `turn.completed` add `turn` with the turn `id`, `input`
  messages, and `sequence`.
- `compaction.requested` adds `compaction.modelId` and
  `compaction.usageInputTokens`; `turn` is `null` for standalone compaction.
- `compaction.completed` adds `compaction.modelId`; `turn` may be `null`.

`tools()` receives a `MemoryToolsContext` with the same `memory` and `turn`
fields plus the ordinary dynamic-resolve context.

### Recall results

A recall handler returns `{ messages }`, `null`, or `undefined`. Each message
has `content` and an optional `id`:

```ts
return {
  messages: [
    { id: "preferred-language", content: "The user prefers Spanish." },
    { content: "A relevant note without a stable identity." },
  ],
};
```

eve adds each message to model context as a user-role message attributed to the
slot. Provider content is never promoted to system instructions.

Use a stable `id` for replaceable facts. A later message with the same ID in
the same slot, namespace, and scope supersedes the earlier one; identical
content is a no-op. Messages without an ID accumulate, even when their content
repeats. Omitting an earlier ID from a later result does not delete it; recall
cannot retract, only supersede.

### Tools

`tools()` returns a map of `defineTool()` values or `null`. eve qualifies each
key as `<slot>__<key>`; the qualified name must start with a letter, contain
only letters, digits, underscores, or dashes, and be at most 64 characters.
Schemas, `approval`, `outputSchema`, and `toModelOutput` work as they do for
authored tools.

A tool closes over the locked scope for the current turn, so it cannot be
redirected to another tenant or caller by the model. eve keeps each tool
callback replayable after a process restart or redeployment.

## Lifecycle

| Phase                  | Handler                           | `messages` contains                                        |
| ---------------------- | --------------------------------- | ---------------------------------------------------------- |
| `turn.started`         | `recall["turn.started"]`          | History before recall; the new delivery is in `turn.input` |
| `turn.completed`       | `capture["turn.completed"]`       | Settled history after a successful turn                    |
| `compaction.requested` | `capture["compaction.requested"]` | History before the checkpoint changes                      |
| `compaction.completed` | `recall["compaction.completed"]`  | The checkpoint plus canonical recalled records             |

At turn start, eve resolves and locks the scope for every active slot before any
recall runs. All slots see the same pre-recall history, and eve commits their
validated results atomically.

During compaction, eve excludes recalled records from the summarizer, keeps the
latest value for each keyed record plus every unkeyed record, and then calls
`recall["compaction.completed"]` against the new checkpoint. This keeps
provider content attributable and prevents a summary from turning it into
ordinary conversation history. If raw superseded records exceed 512 entries or
256 KiB, eve canonicalizes them without waiting for the normal token threshold;
this changes session history only, not the provider's store.

Calling `clear()` on a session removes its history, recalled records, locked
scopes, and replay bookkeeping. It does not touch the provider's store; a later
turn recalls the same data again.

## Failure behavior

- A throwing or invalid `recall["turn.started"]` fails the turn before the
  model call. No slot's recall results are committed. If the turn's
  `abortSignal` is already aborted, eve treats the error as cancellation and
  continues with any queued steering replacement. An `AbortError` with an active
  signal still fails the turn.
- A throwing `capture["compaction.requested"]` leaves history unchanged.
- A throwing `recall["compaction.completed"]` fails an automatic turn. For
  standalone compaction, eve logs the error and returns the session to waiting,
  because the checkpoint has already been written.
- An invalid or throwing `tools()` result is logged and omitted for that turn.
- A throwing `capture["turn.completed"]` is logged after the response and does
  not rewrite the completed turn.

## Requirements

Providers must:

- Partition every read and write by `memory.scope.key`. For semantic
  retrieval, include the key in the query itself, not as a filter after a
  global search.
- Use `operationId` as the idempotency key for `capture` and any other external
  side effect. A workflow replay may invoke the handler again after the side
  effect succeeded but before its completion was recorded.
- Return the same normalized result when eve replays a `recall` handler with the
  same `operationId`. eve records a digest of the accepted result and rejects a
  replay with a different result, so a provider does not need to persist a
  recall result by `operationId` unless its store can change before a replay.
- Enforce their own size and retention policies. eve does not truncate or
  expire provider content.
- Treat recalled content as user-controlled data.

eve enforces these limits on the values it passes to and receives from a
provider:

| Value                                  | Limit             |
| -------------------------------------- | ----------------- |
| Namespace                              | 1,024 UTF-8 bytes |
| Each scope component                   | 1,024 UTF-8 bytes |
| Scope tuple                            | 16 components     |
| Combined canonical namespace and scope | 4,096 bytes       |
| Recall message `id`                    | 1,024 UTF-8 bytes |

## What to read next

- [Memory overview](/docs/memory): slots, scope, namespace, and visibility.
- [File memory](./file): the built-in provider as a reference implementation.
- [Dynamic capabilities](../guides/dynamic-capabilities): the dynamic-tool lifecycle provider tools run through.
- [Default harness](../concepts/default-harness): compaction in the built-in loop.
