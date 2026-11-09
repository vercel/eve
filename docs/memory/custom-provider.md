---
title: "Build a Memory Provider"
description: "Implement the recall, capture, and tools contract so any store or memory service can back an eve memory slot."
---

A memory provider is an object with a `recall` handler and optional `capture`
and `tools` handlers. eve calls the handlers at fixed points in each turn. Each
handler receives the slot's scope key, the conversation, and an operation ID
that stays the same when eve runs the handler again. Package a provider as a
library that exports a factory, or write one inside an agent.

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

`defineMemoryProvider()` accepts three surfaces. Omit any optional handler the
provider doesn't need; `fileMemory()`, for example, has no capture.

| Surface   | Handlers                                     | Responsibility                                        |
| --------- | -------------------------------------------- | ----------------------------------------------------- |
| `recall`  | `"turn.started"` (required)                  | Return messages to place in model context             |
| `capture` | `"turn.completed"`, `"compaction.requested"` | Read the finished conversation and write to the store |
| `tools`   | one function                                 | Return tools for the model, bound to the slot's scope |

### Operation context

Every handler receives a `MemoryOperationContext`:

| Field                    | Meaning                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `memory.scope.key`       | Opaque, versioned digest of the namespace and scope. Use it as the partition key for every read and write. |
| `memory.scope.namespace` | The resolved namespace string                                                                              |
| `memory.scope.value`     | The resolved scope string or tuple                                                                         |
| `memory.slot`            | The path-derived slot name                                                                                 |
| `messages`               | Conversation history for this phase                                                                        |
| `operationId`            | Stable per session, turn, step, phase, and slot. Use it as an idempotency key.                             |
| `abortSignal`            | Cancellation for the operation                                                                             |
| `session`                | Session ID, authentication, and other `SessionContext` fields                                              |

Phase-specific fields:

- `turn.started` and `turn.completed` add `turn` with the turn `id`, `input`
  messages, and `sequence`.
- `compaction.requested` adds `compaction.modelId` and
  `compaction.usageInputTokens`, the input tokens that crossed the threshold or
  `null` for a requested compaction. Its `turn` is the turn the compaction runs
  in, or `null` for a compaction between turns.

`tools()` receives a `MemoryToolsContext` with the same `memory` field, the
session and channel, and an `abortSignal`.

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

eve adds each message to model calls as a user-role message attributed to the
slot, never as system instructions.

What a turn recalls stays for the rest of the session, just before that turn's
input in every later model call. The `id` decides what a later recall does with
it:

| Message           | Effect                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `{ content, id }` | Replaces the message an earlier turn recalled with the same `id`. The same content changes nothing; the earlier copy stays. |
| `{ content }`     | Adds a message. A later recall can't replace or remove it.                                                                  |

A result of `null`, `undefined`, or `{ messages: [] }` adds nothing and keeps
what earlier turns recalled. Give every message a stable `id` when the provider
returns its current state each turn, as `fileMemory()` does, or each turn adds
another copy. Records that differ each turn accumulate for the session and
count toward every model call's context. The `id` also identifies the record in
[instrumentation](../observability/instrumentation).

### Tools

`tools()` returns a `MemoryToolSet`, a map of `defineTool()` values, or `null`. eve qualifies each
key as `<slot>__<key>`. The qualified name must start with a letter, use only
letters, digits, underscores, or dashes, and be at most 64 characters.
Schemas, `approval`, `outputSchema`, and `toModelOutput` work as they do for
authored tools.

A tool keeps the scope it was created with, so the model can't point it at
another tenant or caller. eve resolves the scope once per turn and caller, so
tools and recall use the same scope. A new turn or a new caller resolves it
again. After a restart within the same turn, eve calls `tools()` again with the
same scope.

## Lifecycle

| Phase                  | Handler                           | `messages` contains                                                           |
| ---------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `turn.started`         | `recall["turn.started"]`          | The conversation the turn's first model call reads, with the turn's new input |
| `turn.completed`       | `capture["turn.completed"]`       | The finished history after a successful turn                                  |
| `compaction.requested` | `capture["compaction.requested"]` | The history compaction is about to rewrite                                    |

eve recalls before the first model call of each turn, and again when the
session's caller changes. Recalled messages stay outside history, so
compaction never summarizes them. When compaction summarizes a turn, that
turn's recalled messages move to just after the summary.

Before compaction rewrites history, eve calls `capture["compaction.requested"]`
and waits for it, so a provider can keep detail the summary will lose.

Calling `clear()` on a session removes its history and recalled messages but
not the provider's store, so the next turn recalls again. A new scope, such as
another caller's, also starts over.

## Failure behavior

- A throwing or invalid `recall["turn.started"]` fails the turn before the
  model call, and the next model call recalls again. If the turn's
  `abortSignal` is already aborted, eve treats the error as cancellation and
  continues with any queued follow-up. An `AbortError` with an active
  signal still fails the turn.
- A throwing or invalid `tools()` result fails the turn before the model call,
  like any other [dynamic tool](../guides/dynamic-capabilities#errors-and-recovery).
- A throwing `capture["turn.completed"]` is logged after the response and does
  not rewrite the completed turn.
- A throwing `capture["compaction.requested"]` fails the compaction before it
  rewrites history, which stays as it was. Like a failed summary, a compaction
  that fails during a turn fails the turn.

## Requirements

Providers must:

- Partition every read and write by `memory.scope.key`. For semantic
  retrieval, include the key in the query itself, not as a filter after a
  global search.
- Treat `operationId` as an idempotency key. eve may run a handler again with
  the same ID, such as when an interrupted step retries.
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

- [Memory overview](/docs/memory): slots, scope, and namespace.
- [File memory](./file): the built-in provider as a reference implementation.
- [Dynamic capabilities](../guides/dynamic-capabilities): provider tools run as dynamic tools; see how eve evaluates them.
- [Default harness](../concepts/default-harness): compaction in the built-in loop.
