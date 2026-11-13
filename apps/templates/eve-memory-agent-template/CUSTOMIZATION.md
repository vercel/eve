# Customize your memory agent

Adapt the template's memory and Slack behavior through environment variables and files under `agent/`.

Choose the task you want to complete:

- [Change environment variables](#change-environment-variables)
- [Change writing style and model settings](#change-writing-style-and-model-settings)
- [Customize what the agent remembers](#customize-what-the-agent-remembers)
- [Change who shares a memory](#change-who-shares-a-memory)
- [Choose a different memory provider](#choose-a-different-memory-provider)
- [Use more than one memory provider](#use-more-than-one-memory-provider)
- [Build your own memory provider](#build-your-own-memory-provider)
- [Control Slack identity lookups](#control-slack-identity-lookups)
- [Give the agent shared reference files](#give-the-agent-shared-reference-files)
- [Test and deploy your changes](#test-and-deploy-your-changes)
- [Set up an existing project](#set-up-an-existing-project)

## Change environment variables

For local development, edit `.env.local`. To save a variable in your linked Vercel project, use `vercel env add` followed by its name. For example, to set the Slack connector the agent uses:

```sh
vercel env add SLACK_CONNECTOR
```

Enter the value when prompted and select all Vercel environments to use it throughout the project.

| Vercel environment | Where the value applies                                |
| ------------------ | ------------------------------------------------------ |
| **Production**     | The live agent                                         |
| **Development**    | Local development through `vercel env pull .env.local` |
| **Preview**        | Preview deployments                                    |

To replace an existing variable, append `--force` to the same command. The [Vercel environment variable commands](https://vercel.com/docs/cli/env) also support updating existing values with `vercel env update`.

After changing variables on Vercel, run `vercel env pull .env.local` to download them for local use. Restart `pnpm dev` or deploy again with `vercel deploy --prod` to apply the changes. The examples below use `.env.local` syntax; when the CLI asks for a value, enter only the part after `=`.

## Change writing style and model settings

### Identity and tone

Edit [agent/instructions.md](agent/instructions.md) to describe who the agent works with and how it should respond. For example:

```md
You help a product team in Slack. Use American English and keep answers short unless someone asks for detail. Preserve product names and code identifiers exactly.
```

Keep the existing Memory section alongside your own guidance. It tells the agent when to save to user or channel memory, which preference wins when they conflict, and what it must never save.

### Model and token limits

Change `model` in [agent/agent.ts](agent/agent.ts) to use another [AI Gateway model](https://vercel.com/ai-gateway/models). The template uses `openai/gpt-6.1-sol-fast` and authenticates with Vercel OIDC. For other hosting environments, see [AI Gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok).

The same file limits each session to `300_000` input tokens through `maxInputTokensPerSession`. Each model call counts the input it sends, including earlier messages in the thread, so a long Slack thread reaches the limit sooner than its length suggests. When a session crosses the limit, eve pauses it and asks whether to continue, and **Approve** grants another window of the same size. Increase the limit if threads pause too often. See [eve's agent configuration](https://eve.dev/docs/agent-config) for output and cost limits.

The [current-time instructions](agent/instructions/current-time.ts) add a UTC timestamp at the start of each turn, which covers one message the agent responds to and the work it does for it. If people save preferences that depend on dates or times, such as "I work 9 to 5 Pacific", explain the intended timezone in your instructions.

## Customize what the agent remembers

The agent has two memories, each defined by a file in [agent/memory/](agent/memory/). eve calls each of these files a memory slot, and the file name becomes the slot name. Each slot's scope decides who shares its memory.

| Memory | File | Default scope |
| --- | --- | --- |
| User preferences | [user-preferences.ts](agent/memory/user-preferences.ts) | One Slack user, across every channel and DM |
| Channel preferences | [channel-preferences.ts](agent/memory/channel-preferences.ts) | Everyone in one Slack channel |

Both use eve's built-in file memory. Before each turn, eve recalls each slot's saved entries into the conversation. The model saves and removes entries with each slot's own tools:

| Tool | What it does |
| --- | --- |
| `user-preferences__save_memory` | Saves a preference for the current user |
| `user-preferences__remove_memory` | Removes one of the current user's saved preferences |
| `channel-preferences__save_memory` | Saves a convention for the current channel |
| `channel-preferences__remove_memory` | Removes one of the current channel's saved conventions |

### Change what each memory is for

Edit the `description` in each memory file. eve adds it to the start of that slot's tool descriptions, so it tells the model what belongs in the slot. For example, to have the agent remember each person's role and current projects as well as their preferences:

```ts
description:
  "Remember the user's stable preferences (e.g., tone, language, format, and defaults), their role, and the projects they're working on.",
```

Update the Memory section in [agent/instructions.md](agent/instructions.md) to match. The descriptions say what each slot holds; the instructions decide which slot to use when a message could fit either.

To check your changes:

1. Run `pnpm dev` and tell the agent a preference, such as "I prefer bullet points".
2. Confirm that the agent says it saved the preference.
3. Type `/new` to start a new conversation, then ask for something the preference applies to. The response should follow it.

### Memory size

File memory keeps one document per scope and recalls the whole document on every turn. It rejects writes that exceed its limits instead of truncating or removing older entries:

| Limit            | Value                                            |
| ---------------- | ------------------------------------------------ |
| Recalled message | `maxCharacters`, default 4,000                   |
| One entry        | 2,048 UTF-8 bytes after whitespace normalization |
| Stored document  | 65,536 bytes                                     |

To give a slot more room, pass `maxCharacters` to its provider:

```ts
provider: fileMemory({ maxCharacters: 8_000 }),
```

Every recalled character counts toward the session's input tokens. If a slot needs to hold more than fits in one bounded document, [choose a provider with retrieval](#choose-a-different-memory-provider) instead.

## Change who shares a memory

The slot's `scope` decides who shares its memory. eve resolves the scope from verified Slack session details before each turn, never from what the model or the user types.

| Slot | Scope | Shared by | Disabled for |
| --- | --- | --- | --- |
| User preferences | `byPrincipal` from `eve/memory/scope` | One authenticated user | Anonymous and runtime callers |
| Channel preferences | `bySlackChannel` from [scope.ts](agent/lib/memory/scope.ts) | Everyone in one Slack channel in one workspace | DMs, bots, and non-Slack callers |

When a scope returns `null`, eve skips that slot and its tools for the turn and never falls back to a shared scope. Channel memory returns `null` in DMs because user memory already covers a one-to-one conversation.

During `pnpm dev`, both scopes resolve to a shared `local-dev` scope, and memory lasts only while the development server runs.

### Add a workspace-wide memory

To remember conventions that apply across a whole Slack workspace, create `agent/memory/workspace-preferences.ts`:

```ts
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description:
    "Remember conventions that apply to everyone in the current Slack workspace, such as team names, glossary terms, and house style.",
  provider: fileMemory(),
  scope(ctx) {
    const caller = ctx.session.auth.current;
    if (caller?.principalType === "local-dev") {
      return "local-dev";
    }
    if (
      caller?.authenticator !== "slack-webhook" ||
      caller.principalType !== "user" ||
      !caller.issuer
    ) {
      return null;
    }
    return ["slack-workspace", caller.issuer];
  },
});
```

The issuer identifies the Slack workspace that installed the agent. The model gets two new tools, `workspace-preferences__save_memory` and `workspace-preferences__remove_memory`. Add a line to the Memory section in [agent/instructions.md](agent/instructions.md) saying when to use workspace memory, and that user and channel preferences take priority over it.

Any member of a workspace can change workspace and channel memory. To limit who can, [build your own provider](#build-your-own-memory-provider) whose save tool requires [approval](https://eve.dev/docs/human-in-the-loop) or checks the user's verified Slack ID.

### Namespace and visibility

Two other slot settings work with scope:

- `namespace` separates memory domains before scope is applied. The default combines the slot name with your Vercel project and environment, so preview branches don't share memory with production. To keep a new slot's memory reachable if you later rename its file, give it its own explicit string from its first write, such as `namespace: "acme-support-v1-user-preferences"`. eve uses a custom namespace exactly as written, so two slots that share one string and resolve to the same scope also share memory.
- `visibility` controls what the model sees when a slot's scope changes within one session. The default `"scope"` hides entries recalled for an earlier scope. In a Slack thread with several people, user memory changes scope with each speaker, so one person's preferences drop out of context when someone else replies. Keep the default unless everyone in a session should see each other's memory.

See [eve's memory documentation](https://eve.dev/docs/memory#scope) for scope resolvers and the [multi-tenant memory pattern](https://eve.dev/docs/patterns/multi-tenant-memory) for scoping memory by tenant and user in non-Slack channels.

## Choose a different memory provider

Each slot binds a provider to a scope. eve owns the slot and decides when memory is recalled and captured; the provider decides how memory is stored and found.

| eve owns | The provider owns |
| --- | --- |
| Slot names, derived from the file path | Storage and indexing |
| Namespace and scope resolution from trusted context | Retrieval, ranking, and formatting |
| When recall and capture run, including compaction | What to extract and how to capture it |
| Attribution and supersession of recalled messages | Retention and deletion |
| Qualifying provider tools as `<slot>__<tool>` | Which model-facing tools to offer |

Because of this split, changing a slot's `provider` leaves its scope, namespace, and visibility unchanged. Recalled content always reaches the model as user-role messages, never as system instructions.

### Compare providers

| Provider | Package | Recall | Capture | Storage |
| --- | --- | --- | --- | --- |
| File memory | Built into eve | One bounded document per scope | Model-driven `save_memory` and `remove_memory` tools | Private Vercel Blob store |
| Supermemory | `@supermemory/eve` | Semantic search over stored memories | Automatic after each turn, plus tools | Supermemory hosted service |
| Upstash AgentKit | `@upstash/agentkit-eve` | Ranked Redis Search recall or a Redis document backend | Automatic user-message capture, or model-driven tools | Your Upstash Redis database |
| Kybernesis Arcana | `@kybernesis/arcana` | Semantic search and brain notes | Model-driven tools by default, optional automatic capture | Arcana hosted service |
| Hindsight | `@vectorize-io/hindsight-eve` | Memories relevant to each message, plus a `reflect` tool for questions about past context | Automatic after each turn, optional | Hindsight Cloud or your own Hindsight server |
| Custom provider | Your code | Whatever your store returns | Whatever rules you implement | Any store you operate |

Match your main requirement to a starting provider:

| If the agent needs | Start with |
| --- | --- |
| A short list of preferences, with no extra services | File memory, the template default |
| Automatic capture and semantic recall from a hosted service | Supermemory |
| Memory stored in a Redis database you already use | Upstash AgentKit |
| Semantic search with model-driven saving by default | Kybernesis Arcana |
| Automatic capture with the option to self-host the memory service | Hindsight |
| Memory in your own database, or retention rules you enforce | [A custom provider](#build-your-own-memory-provider) |

These questions narrow the choice:

| Question | What to consider |
| --- | --- |
| Should memory be captured automatically? | Supermemory and Hindsight capture completed turns, Upstash AgentKit captures user messages by default, and Arcana captures turns when enabled. File memory stores only what the model deliberately saves, which suits a team agent where saving should be a visible action. |
| Does the agent need semantic retrieval? | File memory recalls the whole document every turn. Once memory outgrows that, choose a provider that retrieves only relevant records. |
| Where should data live? | File memory, Upstash AgentKit, and custom providers keep data in infrastructure you control. Supermemory and Arcana keep it in their hosted services, which affects billing and data residency. Hindsight uses its hosted service by default, or a Hindsight server you run. |
| Does local development need to work offline? | File memory runs in `pnpm dev` with no account or credentials. Hosted providers need their credentials in `.env.local` first. |

### Switch a slot's provider

Install a provider with `pnpm exec eve add`, then point an existing slot at it. For example, to move channel memory to Supermemory:

```sh
pnpm exec eve add memory/supermemory
```

The command installs `@supermemory/eve` and writes a new `agent/memory/supermemory.ts` slot. To replace channel memory rather than add a third slot, move its provider into [channel-preferences.ts](agent/memory/channel-preferences.ts), keep the existing `scope`, and delete `supermemory.ts`:

```ts
import supermemory from "@supermemory/eve";
import { defineMemory } from "eve/memory";

import { bySlackChannel } from "../lib/memory/scope";

export default defineMemory({
  description:
    "Recall and manage durable context for the current Slack channel that applies to everyone in it.",
  provider: supermemory({
    apiKey: process.env.SUPERMEMORY_API_KEY!,
  }),
  scope: bySlackChannel,
});
```

Supermemory captures every completed turn, so channel memory will also hold personal statements made in the channel. Update the Memory section in [agent/instructions.md](agent/instructions.md) to match. Add `SUPERMEMORY_API_KEY` with the [CLI commands above](#change-environment-variables). The other providers follow the same pattern:

| Provider | Install command | Provider code | Environment variables |
| --- | --- | --- | --- |
| Supermemory | `pnpm exec eve add memory/supermemory` | `supermemory({ apiKey })` | `SUPERMEMORY_API_KEY` |
| Upstash AgentKit | `pnpm exec eve add memory/upstash-agentkit` | `redisMemory({ topK: 5 })` from `@upstash/agentkit-eve/memory` | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| Kybernesis Arcana | `pnpm exec eve add memory/arcana` | `arcanaMemory({ apiKey, workspace })` from `@kybernesis/arcana/memory` | `ARCANA_API_KEY`, `ARCANA_WORKSPACE` |
| Hindsight | `pnpm add @vectorize-io/hindsight-eve` | `hindsightMemory()` from `@vectorize-io/hindsight-eve` | `HINDSIGHT_API_KEY`, plus `HINDSIGHT_API_URL` for a self-hosted server |

`topK` sets how many facts Upstash AgentKit recalls. To have Arcana capture completed turns automatically, add `capture: { enabled: true }` to its options.

Install Hindsight with `pnpm add` and create the slot file yourself, because `eve add extension/hindsight` writes an older setup that shares one memory store across every user. Hindsight gives each scope its own memory bank by default, so leave `HINDSIGHT_BANK_ID` unset in this multi-user agent. Pass `capture: false` to `hindsightMemory()` when a slot should only recall, such as channel memory that shouldn't record personal statements automatically.

To keep file memory's model-curated document but store it in Redis instead of Vercel Blob, use Upstash AgentKit's document backend:

```ts
import { redisDocuments } from "@upstash/agentkit-eve/memory";
import { fileMemory } from "eve/memory/file";

provider: fileMemory({ backend: redisDocuments() }),
```

Existing memories stay in the previous provider's storage and don't move to the new one. Plan a migration, or run both providers in separate slots while you transition. Setup details for each provider are in the [Supermemory](https://supermemory.ai/docs/integrations/eve), [Upstash AgentKit](https://upstash.com/docs/redis/sdks/agentkit/eve), [Arcana](https://github.com/KybernesisAI/platform/tree/master/packages/arcana#readme), and [Hindsight](https://hindsight.vectorize.io/sdks/integrations/eve) documentation.

## Use more than one memory provider

Slots are independent, so each one can use a different provider. For example, keep user preferences in file memory for a short, curated list, and add a `knowledge.ts` slot that uses Supermemory for semantic recall of past conversations:

```text
agent/
  memory/
    user-preferences.ts
    channel-preferences.ts
    knowledge.ts
```

Each slot gets its own recalled context and its own tools, qualified with the slot name, such as `knowledge__<tool>`. The default namespace includes the slot name, so slots stay separate even when they resolve to the same scope.

Renaming a slot file changes its default namespace, which makes its earlier memories unreachable. To rename a slot that already holds data, return its old default namespace from the renamed file:

```ts
import { defaultNamespace, defineMemory } from "eve/memory";

// in the renamed slot file
namespace: (ctx) => defaultNamespace({ ...ctx, slot: "user-preferences" }),
```

Switching an existing slot to an explicit namespace string orphans its memories in the same way, so plan a migration if you need a different namespace. Declaring a single `agent/memory.ts` file creates one slot named `memory`, and that form can't be combined with the `agent/memory/` directory.

## Build your own memory provider

Build a provider when memory must live in your own database or follow retention rules you control. eve still handles scope, lifecycle timing, and isolation between scopes, so a provider only implements storage and retrieval.

Create a provider with `defineMemoryProvider()` from `eve/memory`. It accepts three surfaces. Only `recall` is required, and it must implement `"turn.started"`.

| Surface | Handlers | Responsibility |
| --- | --- | --- |
| `recall` | `"turn.started"` (required), `"compaction.completed"` | Return messages to place in model context |
| `capture` | `"turn.completed"`, `"compaction.requested"` | Observe settled history and write to the store |
| `tools` | One function | Return model-facing operations bound to the locked scope |

Every handler receives a context with these fields:

| Field | Meaning |
| --- | --- |
| `memory.scope.key` | Opaque, versioned digest of the namespace and scope. Use it as the partition key for every read and write. |
| `memory.scope.namespace` | The resolved namespace string |
| `memory.scope.value` | The resolved scope string or tuple |
| `memory.slot` | The slot name, derived from the file path |
| `messages` | Conversation history for the current phase |
| `operationId` | Stable per session, turn, step, phase, and slot. Use it as an idempotency key. |
| `abortSignal` | Cancellation signal for the operation |
| `session` | Session ID, authentication, and other session fields |

When a session's turns approach the model's context window, eve compacts them by summarizing older turns into a checkpoint. The contents of `messages`, and any extra fields, depend on when eve calls the handler:

| Phase | Handler | `messages` contains | Extra fields |
| --- | --- | --- | --- |
| `turn.started` | `recall["turn.started"]` | History before recall. The new message is in `turn.input`. | `turn`, with the turn `id`, `input` messages, and `sequence` |
| `turn.completed` | `capture["turn.completed"]` | Settled history after a successful turn | `turn`, with the turn `id`, `input` messages, and `sequence` |
| `compaction.requested` | `capture["compaction.requested"]` | History before the checkpoint changes | `compaction.modelId` and `compaction.usageInputTokens`. `turn` is `null` for standalone compaction. |
| `compaction.completed` | `recall["compaction.completed"]` | The checkpoint plus the retained recalled messages | `compaction.modelId`. `turn` may be `null`. |

### 1. Connect your store

The examples below use a `notes` client exported from `agent/lib/notes-db.ts`. Replace it with the client for your database or service. The provider calls three methods, each taking a `partition` that you map to your store's partition or tenant field:

| Method | Called from | Purpose |
| --- | --- | --- |
| `notes.search({ partition, query, limit })` | `recall` | Return the most relevant records for the scope |
| `notes.ingest({ partition, idempotencyKey, messages })` | `capture` | Write a completed turn once per operation |
| `notes.delete({ partition, id })` | `tools` | Remove one record by ID within the scope |

Always pass `ctx.memory.scope.key` as the partition. Constraining every read and write by that key is what keeps one user's or channel's memory separate from another's.

### 2. Recall context before each turn

eve calls `recall["turn.started"]` before the model call, after resolving and locking the scope for every active slot. Create the provider in `agent/lib/notes-memory.ts`:

```ts
import { defineMemoryProvider } from "eve/memory";

import { notes } from "./notes-db";

export const notesMemory = () =>
  defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        const rows = await notes.search({
          limit: 5,
          partition: ctx.memory.scope.key,
          query: ctx.turn.input,
        });
        return {
          messages: rows.map((row) => ({ content: row.text, id: row.id })),
        };
      },
    },
  });
```

Return `{ messages }`, `null`, or `undefined`. Each message needs non-blank `content` and may have an `id`; eve rejects any other keys. Give replaceable facts a stable `id`, such as the record's primary key:

| Recalled message | Result in the session |
| --- | --- |
| Same `id` as before, new content | Replaces the earlier message |
| Same `id` as before, same content | No change |
| No `id` | Accumulates, even when the content repeats |
| Earlier `id` left out of a result | The earlier message stays, because recall can't retract |

Implement `recall["compaction.completed"]` to refresh context after eve compacts a long session. `ctx.turn` may be `null` in that phase, so don't read `ctx.turn.input` there without a fallback.

### 3. Capture turns and expose tools

Add `capture["turn.completed"]` to write each successful turn to your store, and a `tools` function for operations the model can call directly:

```ts
import { defineMemoryProvider } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { notes } from "./notes-db";

export const notesMemory = () =>
  defineMemoryProvider({
    capture: {
      async "turn.completed"(ctx) {
        await notes.ingest({
          idempotencyKey: ctx.operationId,
          messages: ctx.messages,
          partition: ctx.memory.scope.key,
        });
      },
    },
    recall: {
      async "turn.started"(ctx) {
        const rows = await notes.search({
          limit: 5,
          partition: ctx.memory.scope.key,
          query: ctx.turn.input,
        });
        return {
          messages: rows.map((row) => ({ content: row.text, id: row.id })),
        };
      },
    },
    async tools(ctx) {
      return {
        forget: defineTool({
          description: "Delete a remembered note by its ID.",
          async execute({ id }) {
            await notes.delete({ id, partition: ctx.memory.scope.key });
            return { deleted: true };
          },
          inputSchema: z.object({ id: z.string() }),
        }),
      };
    },
  });
```

eve may replay a handler with the same operation ID, so pass `ctx.operationId` as the idempotency key. If your client accepts a cancellation signal, pass `ctx.abortSignal` too. Skip capture if the model should decide what to save through tools, as file memory does. Implement `capture["compaction.requested"]` to persist history before eve replaces it with a compaction checkpoint.

eve qualifies each tool key as `<slot>__<key>`, so `forget` in a slot named `notes` reaches the model as `notes__forget`. The qualified name must start with a letter, use only letters, digits, underscores, or dashes, and stay within 64 characters. Schemas, `approval`, `outputSchema`, and `toModelOutput` work as they do for tools under `agent/tools/`. Use `approval` to require confirmation before the model saves or deletes memory.

Each tool closes over the scope locked for the current turn, so the model can't redirect it to another user or channel. After a restart or redeployment, eve calls `tools()` again with the captured context to replay tool calls.

### 4. Bind the provider to a slot

Create `agent/memory/notes.ts`. Reuse one of the template's scopes, or write your own as in the [workspace example](#add-a-workspace-wide-memory):

```ts
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

import { notesMemory } from "../lib/notes-memory";

export default defineMemory({
  description: "Notes the user has asked the agent to remember.",
  provider: notesMemory(),
  scope: byPrincipal,
});
```

To store channel memory in your provider instead, import `bySlackChannel` from [scope.ts](agent/lib/memory/scope.ts). Both template scopes already include the Slack workspace, so memory from different workspaces never shares a partition.

### 5. Test the provider locally

eve doesn't print a confirmation when a slot loads, so test the provider by its behavior:

1. Run `pnpm dev` and ask the agent to remember a fact.
2. Type `/new` to start a new conversation, and confirm the fact appears in the agent's answer.
3. Ask the agent to forget it, then check that the record is gone from your store under that scope's partition.

Locally, every session resolves to the shared `local-dev` scope, so all local sessions read and write the same partition. When a scope or namespace returns `null`, `pnpm dev` logs a `Memory slot is disabled for this operation` message instead of calling your provider. The message names the slot and the resolver, but never the scope value.

Add unit tests for your provider beside it, as [scope.test.ts](agent/lib/memory/scope.test.ts) does for the template's channel scope.

### Provider requirements and limits

Every provider must:

- Use `memory.scope.key` in every read and write. For semantic retrieval, include the key in the query itself rather than filtering a global search afterward.
- Deduplicate by operation ID, because eve may replay a handler with the same ID, and replaying a recall with a different result is an error.
- Enforce your own size limits and retention policies, because eve doesn't truncate or expire provider content.
- Treat recalled content as untrusted user data, even when your provider wrote it.

eve enforces these limits on values passed to and from a provider:

| Value                                  | Limit             |
| -------------------------------------- | ----------------- |
| Namespace                              | 1,024 UTF-8 bytes |
| Each scope component                   | 1,024 UTF-8 bytes |
| Scope tuple                            | 16 components     |
| Combined canonical namespace and scope | 4,096 bytes       |
| Recall message `id`                    | 1,024 UTF-8 bytes |

Clearing a session removes its history and recalled messages, but not your store's data. The next turn recalls the same records again.

### Troubleshoot a custom provider

How a handler failure affects the turn depends on when the handler runs:

| Handler | When it throws or returns an invalid result |
| --- | --- |
| `recall["turn.started"]` | The turn fails before the model call, and no slot's recalled messages are saved. If the turn was already cancelled, eve treats the error as cancellation. |
| `capture["turn.completed"]` | eve logs the error after the response and leaves the completed turn unchanged. |
| `capture["compaction.requested"]` | Session history stays unchanged. |
| `recall["compaction.completed"]` | Automatic compaction fails the turn. Standalone compaction logs the error and returns the session to waiting, because the checkpoint is already written. |
| `tools()` | eve logs the error and omits the provider's tools for that turn. |

| Symptom | Cause and fix |
| --- | --- |
| The same fact appears more than once | Messages without an `id` accumulate. Return a stable `id` for each record. |
| A deleted record still appears in the current session | Recall can replace earlier messages but not retract them. Later sessions won't recall it. To update the current session, recall the same `id` with placeholder content such as "No memories are saved."; blank content fails the turn. |
| The turn fails with a recall validation error | Check that the result only contains `messages`, each message only has `content` and `id`, `content` isn't blank, and no two messages share an `id`. |
| The provider's tools don't reach the model | Check the logs for a `tools()` error, and confirm every qualified tool name meets the naming rules above. |
| One user's memory appears for another | A store query isn't constrained by `memory.scope.key`. Pass the key into every search, write, and delete. |

The full provider contract is in [eve's memory provider guide](https://eve.dev/docs/memory/custom-provider), and the built-in [file memory](https://eve.dev/docs/memory/file) provider is a working reference.

## Control Slack identity lookups

Before responding to each message, the agent looks up the Slack profile of everyone involved in the thread and adds their names and profile images to the conversation as context. This uses the `users:read` permission. The agent never adds email addresses, so it can't reveal them to other people in a channel. Profile names help the agent address people, but memory scopes use verified Slack IDs, never names.

To skip profile lookups for selected bot or service accounts, set:

```dotenv
SLACK_IDENTITY_EXCLUDED_USER_IDS=U0123456789,U0987654321
```

Excluded users can still interact with the agent; this setting only skips their profile lookups. The lookup code and its tests are in [identity.ts](agent/lib/integrations/slack/identity.ts) and [identity.test.ts](agent/lib/integrations/slack/identity.test.ts).

## Give the agent shared reference files

Memory holds short preferences that the agent saves during conversations. For longer documents your team maintains, such as runbooks or a glossary of internal terms, store the files on a [Vercel Drive](https://vercel.com/kb/guide/vercel-drives) and mount it into the agent's sandbox. The agent then searches and reads them with its built-in shell and file tools.

The agent can't change these files, because each conversation mounts a read-only snapshot of the Drive taken when its sandbox starts. You update the files yourself, and new conversations see the changes.

### 1. Create a Drive and add files

From your agent's repository directory, create the Drive and a temporary sandbox that mounts it with write access:

```sh
vercel sandbox drives get-or-create team-docs
vercel sandbox create --name team-docs-writer --mount team-docs:/team-docs:read-write --timeout 30m
```

Copy your files into the mounted Drive. `vercel sandbox copy` transfers one file per run, so loop over a local folder:

```sh
for file in ./runbooks/*.md; do
  vercel sandbox copy "$file" "team-docs-writer:/team-docs/$(basename "$file")"
done
```

Replace `./runbooks/*.md` with the path to your files. When the copies finish, remove the temporary sandbox:

```sh
vercel sandbox remove team-docs-writer
```

The files stay on the Drive after the sandbox is removed. Only one sandbox at a time can mount a Drive with write access, so removing the writer also frees the Drive for your next update. The Drive must belong to the agent's Vercel project, because Drive names are scoped to a project. If the CLI doesn't select that project, pass `--project` with its name.

### 2. Mount the Drive in the agent's sandbox

Replace [agent/sandbox.ts](agent/sandbox.ts) with:

```ts
import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";
import { VercelSandbox } from "eve/sandbox/vercel";

const deployed = process.env.VERCEL === "1";

/**
 * Sandbox environment for the agent: Vercel Sandbox when deployed, just-bash locally.
 */
export const environment = deployed
  ? VercelSandbox.environment()
  : JustBashSandbox.environment({ autoInstall: false });

/**
 * Opens the session sandbox, mounting a read-only snapshot of the team-docs Drive when deployed.
 *
 * @returns The opened sandbox, without the Drive if it can't be mounted.
 */
export default defineSandbox(async () => {
  if (!deployed) {
    return environment.open();
  }
  try {
    return await environment.open({
      mounts: { "/team-docs": { drive: "team-docs", mode: "snapshot" } },
      networkPolicy: "deny-all",
    });
  } catch (error) {
    console.warn("team_docs.unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return environment.open({ networkPolicy: "deny-all" });
  }
});
```

The sandbox and the Drive must be in the same region. Both default to `iad1`, so this works unless you created the Drive with `--region`; in that case, pass the same region to `VercelSandbox.environment({ region: "sfo1" })`. If the Drive can't be mounted, for example because no files have been copied to it yet, the agent logs `team_docs.unavailable` and continues without the files.

Local sessions use `just-bash`, which can't mount Drives, so test the files through the deployed agent in Slack.

### 3. Tell the agent when to use the files

Create a skill at `agent/skills/team-docs.md`. eve shows the model only the skill's `description`, and the model loads the full instructions when a request matches it, so they don't add to every conversation:

```md
---
description: Use when someone asks about team runbooks or internal terminology.
---

Search the files under `/team-docs` with `grep` before answering. Name the file you used in your answer. If the files don't cover the question, say so instead of guessing.
```

Deploy the changes, then start a new Slack thread and ask a question that one of your files answers.

### Update the files

Repeat the steps in [Create a Drive and add files](#1-create-a-drive-and-add-files) to add or replace files. To delete a file, open a shell in the writer sandbox with `vercel sandbox connect team-docs-writer` and remove it from `/team-docs` before removing the sandbox. Existing Slack threads keep the snapshot they started with, so start a new thread to see the updated files.

Drives are billed for storage, reads, and writes. See [Sandbox pricing](https://vercel.com/docs/sandbox/pricing#drive-storage) for rates and Hobby allotments.

## Test and deploy your changes

Run the project checks before deploying:

```sh
pnpm validate
pnpm exec eve info
pnpm build
```

Save any environment variable changes with the [CLI commands above](#change-environment-variables), then deploy:

```sh
vercel deploy --prod
```

The automated tests don't call Slack or your memory storage, so test in Slack after deploying. Slack events reach only your production deployment unless you set up a separate preview connector as described in [eve's guide to testing a preview branch](https://eve.dev/docs/channels/slack#test-a-preview-branch). Tell the agent a personal preference, then a preference for the whole channel, and confirm it saves each to the right memory. Reply from a second Slack account and check that only the channel preference applies to them. Then start a new thread and ask the agent what it remembers about you and the channel.

## Set up an existing project

Use these steps if you have a Vercel project but haven't connected Slack or memory storage through the [template setup](README.md#getting-started). With the [Vercel CLI](https://vercel.com/docs/cli) installed, open a terminal in your agent's repository directory and run:

```sh
vercel link
```

Select your existing Vercel project when prompted. This tells subsequent CLI commands which project to configure.

### Connect Slack

Create a connector and register the agent's Slack route:

```sh
vercel connect create slack --name memory-agent \
  --triggers --trigger-path /eve/v1/slack
vercel connect attach slack/memory-agent
```

Follow the browser prompts to connect the agent to your Slack workspace. If you choose another name, use it in the attach command and `SLACK_CONNECTOR` below. Events go to the production deployment at `/eve/v1/slack`. See [eve's Slack guide](https://eve.dev/docs/channels/slack) for event subscriptions and troubleshooting.

### Store memory

File memory saves user and channel preferences in a private Vercel Blob store. If your project already has one connected for memory, skip this step. Otherwise, run:

```sh
vercel blob create-store memory-agent-memory --access private --yes
```

This connects the store to all project environments and sets `BLOB_STORE_ID`. The agent accesses it using Vercel OIDC. `BLOB_STORE_ID` is the default variable for any connected Blob store. If you later connect a store for your own app data, choose a different environment variable prefix when you connect it in the Vercel dashboard so memory stays in its own store. Without a connected store, memory fails on Vercel with an error asking you to set one up. If you switched to [another provider](#choose-a-different-memory-provider), configure its credentials instead.

### Configure and deploy

Add the Slack connector name:

```sh
vercel env add SLACK_CONNECTOR
```

Enter `slack/memory-agent`, matching the connector created above, and select all environments. If the variable already exists, repeat the command with `--force` to replace its value.

Download the environment variables for local use, then deploy:

```sh
vercel env pull .env.local
vercel deploy --prod
```

Invite the agent to a Slack channel and tell it a preference. For local testing, use `pnpm dev` after downloading the environment variables.
