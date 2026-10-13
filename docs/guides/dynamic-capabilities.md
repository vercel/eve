---
title: "Dynamic Capabilities"
description: "Choose the model, subagents, connections, tools, skills, and instructions per session with defineDynamic: select what a capability depends on, and render it."
---

`defineDynamic` makes a capability depend on the session instead of declaring it up front. Reach for it when the right model, subagents, connections, tools, skills, or instructions depend on who the caller is, what tenant they belong to, a feature flag, the conversation so far, or external data. The [subagents](../subagents), [connections](../connections), [tools](../tools), [skills](../skills), and [instructions](../instructions) guides each point here for their dynamic form.

A dynamic definition has two parts:

- `select(view, ctx)` reads what the capability depends on and returns it as JSON. It is synchronous.
- `render(selected)` makes the capability from what `select` returned. It is synchronous and deterministic, and it can return code such as tools and auth callbacks.

When making the capability needs I/O, add `record(selected, ctx)`. It runs once for each new selection, may await, and returns JSON that eve keeps in the session and passes to `render`.

```ts title="agent/tools/admin.ts"
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { deleteUser, listUsers } from "../lib/users";

const list_users = defineTool({
  description: "List the workspace's users.",
  inputSchema: z.object({}),
  execute: () => listUsers(),
});

const delete_user = defineTool({
  description: "Delete a user from the workspace.",
  inputSchema: z.object({ userId: z.string() }),
  execute: ({ userId }) => deleteUser(userId),
});

const everyone = { list_users };
const admins = { list_users, delete_user };

export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.role ?? null,
  render: (role) => (role === "admin" ? admins : everyone),
});
```

The folder decides what the definition makes: a model in the `model` field of `agent.ts`, a subagent in `agent/subagents/`, connections in `agent/connections/`, tools in `agent/tools/`, skills in `agent/skills/`, and instructions in `agent/instructions/`. Import `defineDynamic` from the entry point for that folder: `eve/models` for a model, `eve` for a subagent, and `eve/connections`, `eve/tools`, `eve/skills`, or `eve/instructions`.

eve evaluates a dynamic definition module once during compilation to classify and validate it, then keeps the module as a runtime entry so `select`, `record`, and `render` can run. Its top-level code runs in both phases, so keep caller-specific work inside those functions. See [Authored module lifecycle](../reference/typescript-api#authored-module-lifecycle).

## Select what the capability depends on

`select` receives the session's view and context, and returns JSON. eve compares what it returns with the previous selection: the same selection keeps the capability, and a different one makes it again. Select only what should change the capability, because a change to anything else does not.

| Read               | What it holds                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `view.turn`        | The latest turn, with its `id`, `status`, and the `input` it started with; `null` before the first turn                |
| `view.messages`    | The conversation as the next model call reads it                                                                       |
| `view.model`       | The model the session uses now, as `{ id }`; available to subagents, connections, tools, skills, and instructions only |
| `view.latest`      | The stream position of the latest event of each type, such as `view.latest["model.requested"]`                         |
| `view.calls`       | The session's calls, and the other tables of the [session view](../concepts/sessions-runs-and-streaming)               |
| `ctx.session`      | The session `id`, its `auth` (`current` and `initiator`), `schedule`, and `predecessor`                                |
| `ctx.channel`      | The channel `kind`, `continuationToken`, and `metadata`                                                                |
| `ctx.conversation` | The conversation's audience and environment, when known                                                                |

`select` must be synchronous, deterministic, and return at most 64 KB of JSON. Select an ID and look the rest up in `record` rather than selecting large data.

eve provides selections for the common lifetimes:

| Helper            | The capability is made again                                                            |
| ----------------- | --------------------------------------------------------------------------------------- |
| `select: once`    | Never: once per session                                                                 |
| `select: perTurn` | When a new turn starts. Messages that steer the running turn don't start one            |
| `select: perStep` | Before every model call of a turn, including the call after a tool batch or an approval |

Import `once`, `perTurn`, and `perStep` from the same entry point as `defineDynamic`. To combine a lifetime with other data, return both, such as `{ turn: view.turn?.id ?? null, plan }`.

## When eve evaluates a dynamic capability

eve evaluates every dynamic capability before each model call of a turn. It runs each `select`, and calls `record` and `render` only for a selection that changed. What a call is offered is fixed when it starts: a capability that changes during a tool batch reaches the next model call.

- **Steering.** A message that joins the running turn is in `view.messages` at the next model call, without a new turn.
- **Approvals and questions.** A paused turn evaluates nothing until it resumes. An approved call runs first, then the next model call evaluates again.
- **Compaction.** Compacting the conversation evaluates nothing. The next model call reads the compacted conversation.
- **Deployments.** A session that moves to a new deployment evaluates every dynamic capability again before its next model call, with the new deployment's code.

Compaction's own summarization call, the `auto` model's decision, and a tool's own model calls are not model calls of the turn, so `perStep` doesn't count them.

## Fetch data with record

Use `record` when `render` needs data that takes I/O, such as a tenant's configuration, an account list, or a document. eve calls `record` once for each new selection, keeps the JSON it returns in the session, and passes it to `render`:

```ts title="agent/tools/warehouse.ts"
import { defineDynamic, defineTool, once } from "eve/tools";
import { z } from "zod";
import { listTables, runReadOnly } from "../lib/warehouse";

export default defineDynamic({
  select: once,
  record: async () =>
    (await listTables()).map((table) => ({ name: table.name, columns: table.columns })),
  render: (tables) =>
    Object.fromEntries(
      tables.map((table) => [
        table.name,
        defineTool({
          description: `Query ${table.name}. Columns: ${table.columns.join(", ")}`,
          inputSchema: z.object({ sql: z.string() }),
          execute: ({ sql }) => runReadOnly(table.name, sql),
        }),
      ]),
    ),
});
```

`record` receives the selection and a context with `ctx.session`, `ctx.channel`, `ctx.conversation`, and an `abortSignal`. Read the conversation with `await ctx.messages()`. eve does not watch what `record` reads from its context: a change there does not run `record` again. Select it when it should.

What `record` returns is kept in the session's durable state for every later step, so it must be JSON, at most 1 MB. Anything `record` returns is stored, so return what `render` needs, such as a tenant ID, rather than a credential. Mint tokens in the code `render` returns, such as a tool's `execute` or a connection's `getToken`, where they are created for each request.

When the data is the capability itself, such as a skill's markdown or a model ID, `record` can stand alone, without `render`. Tools and connections are code, so they always need `render`.

## Keep render deterministic

`render` makes the capability, and it runs again wherever the session continues: in a fresh process after a cold start, or after an approval resumes on another instance. A fresh process does not run `record` again; it renders from what the session kept. So `render` must return the same capability for the same input: keep randomness, the current time, and I/O in `record`.

Synchronous does not mean deterministic, so eve checks. In `eve dev`, eve renders a capability that carries code, such as tools, connections, a model object, or remote credentials, twice, and fails the turn when the results differ. In a fresh process, eve compares what `render` returns with what the session was offered, such as tool names, descriptions, and schemas. When they differ, eve discards the kept record, and the next model call evaluates the capability again.

## Failures

A `select`, `record`, or `render` that throws, or returns a value its folder can't use, fails the turn before its model call. eve keeps nothing for the failed evaluation, so the session keeps the last capability it had, and the next model call evaluates it again, even with the same selection. A new message, for example, retries it.

To keep the turn running when a dependency fails, catch the error in `record` and return a fallback, such as `null`. A caught failure is an ordinary result: eve keeps it until the selection changes. Select `perTurn` to try again each turn.

## Dynamic models

The `model` field in `agent.ts` accepts `defineDynamic` from `eve/models`. `render` or `record` returns a gateway model ID, an AI SDK `LanguageModel`, or a selection object, `{ model, reasoning?, modelContextWindowTokens?, modelOptions? }`. A `LanguageModel` is code, so return it from `render`. See [agent configuration](../agent-config#choose-the-model-dynamically) for the selection object.

Prefer `select: once`: prompt caches are per model, so switching mid-session re-ingests the conversation at uncached prices. To choose a model from the incoming prompt with a decision model, use [`auto` from `eve/models`](./decide).

### Route image inputs to a vision model

Select from the conversation when the model depends on it. This keeps GLM for text and switches to Gemini Flash once the conversation contains an image:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";

export default defineAgent({
  model: defineDynamic({
    select: (view) =>
      view.messages.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part.type === "image" ||
              (part.type === "file" &&
                (part.mediaType === "image" || part.mediaType.startsWith("image/"))),
          ),
      ),
    render: (hasImage) => (hasImage ? "google/gemini-3.5-flash" : "zai/glm-5.2"),
  }),
});
```

eve stages byte-backed `file` parts under `/workspace/.eve/attachments` before the model call, but keeps their media type in `view.messages`. When an image reaches the provider, vision models can process it and non-vision models reject it. eve does not reroute automatically. See [Inbound attachments](../sandbox#inbound-attachments).

A dynamic model does not compile a default model or model metadata. When it first selects a model, eve normalizes the selection and resolves any omitted context-window metadata from the AI Gateway catalog. A dynamic model that returns `null` selects no model, and a model call that needs one fails.

## Dynamic subagents

Wrap a declared subagent's own `agent.ts` in `defineDynamic` when its availability depends on the caller, tenant, environment, or a feature flag. Return the child definition to configure and expose it. Return `null` to omit it from the parent's model-visible tools.

The example below exposes a finance subagent to enterprise callers and gives it the model the parent uses:

```ts title="agent/subagents/finance/agent.ts"
import { defineAgent, defineDynamic } from "eve";

export default defineDynamic({
  select: (view, ctx) => ({
    enterprise: ctx.session.auth.current?.attributes.plan === "enterprise",
    model: view.model?.id ?? null,
  }),
  render: ({ enterprise, model }) =>
    enterprise
      ? defineAgent({
          description: "Analyze financial and accounting data.",
          model: model ?? "openai/gpt-5.5-mini",
        })
      : null,
});
```

The child gets the parent's model ID when the subagent renders, along with the parent's context-window metadata for that model. Because the model is part of the selection, a parent model change renders the subagent again.

eve always compiles the subagent's filesystem resources, including its instructions, tools, skills, connections, sandbox, and nested subagents. It does not compile an agent config or placeholder model for a dynamic subagent. When the subagent is selected, eve combines the returned config with those resources before starting the child session. A returned local config must use a static model; it cannot contain another `defineDynamic` model. Put `build` and `defaultTools` beside `select` on the outer definition; they cannot be returned from `render`.

### Dynamic remote agents

A single-file remote subagent uses the same form. Return `defineRemoteAgent(...)` to expose the selected deployment, or `null` to omit it:

```ts title="agent/subagents/finance.ts"
import { defineDynamic, defineRemoteAgent } from "eve";
import { mintFinanceToken } from "../lib/finance";

export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.tenant ?? null,
  render: (tenant) =>
    typeof tenant === "string"
      ? defineRemoteAgent({
          description: "Analyze financial and accounting data.",
          url: `https://${tenant}.finance-agent.example.com`,
          auth: async () => ({
            headers: { authorization: `Bearer ${await mintFinanceToken(tenant)}` },
          }),
        })
      : null,
});
```

The returned remote definition can set its URL, path, headers, auth, and principal forwarding. `auth` and `headers` are code, so return them from `render`; eve rejects a remote agent with credentials that `record` returns. They resolve before each outbound request and never enter durable state.

A child session keeps the selection it was opened with. Every later request to that child, including messages, answers to its questions, cancellation, and following its stream, renders the child's credentials from that selection, not from the parent's current one. If the deployment's `render` no longer returns the child's URL for that selection, eve sends no credentials and the request fails. Open a new child for the new destination.

### Availability

The selected set applies to local and remote direct delegation. An authored workflow tool can also call a selected subagent through `ctx.agent`, and a generated program can call it through the `workflow` tool. eve checks availability again before starting the child, so a call to a subagent the session no longer selects fails. Treat conditional availability as capability composition, not as the only authorization boundary: sensitive child tools still need their own authorization and approval checks.

## Dynamic connections

Use a dynamic connection when the available MCP servers or OpenAPI services depend on the authenticated caller. `render` returns one `defineMcpClientConnection(...)` or `defineOpenAPIConnection(...)`, a map of connection definitions, or `null`. Wrap every returned connection in its protocol helper. Select accounts and endpoints from authenticated session identity or application-owned data, not from conversation messages or channel metadata.

This example exposes one MCP connection for each cloud account enabled for the current user:

```ts title="agent/connections/accounts.ts"
import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { listEnabledAccounts, mintAccountToken } from "../lib/accounts";

export default defineDynamic({
  select: (_view, ctx) => {
    const principal = ctx.session.auth.current;
    return principal?.principalType === "user" ? principal.principalId : null;
  },
  record: async (userId) =>
    userId === null
      ? []
      : (await listEnabledAccounts(userId)).map(({ accountId, label, slug }) => ({
          accountId,
          label,
          slug,
        })),
  render: (accounts) =>
    Object.fromEntries(
      accounts.map((account) => [
        account.slug,
        defineMcpClientConnection({
          url: "https://mcp.cloud.example.com",
          description: `${account.label} (${account.accountId})`,
          instanceKey: account.accountId,
          auth: {
            credentialOwner: "user",
            getToken: ({ principal }) => mintAccountToken(principal, account.accountId),
          },
        }),
      ]),
    ),
});
```

The returned definitions use the same auth, headers, filtering, provided arguments, and approval options as static [MCP](../connections/mcp) and [OpenAPI](../connections/openapi) connections. eve announces each connection to the model in an append-only context message, and the model reaches its tools through `eve__search` and `eve__tool`, so the tool list never changes.

Set `instanceKey` on every authenticated dynamic connection. Use a stable, non-secret account or tenant identifier, and change it whenever the endpoint, account, or auth provider changes. eve hashes the value before storing the resolved instance identity in durable authorization state. If a parked sign-in callback resumes after the session selects a different instance, eve rejects the callback instead of passing it to the new connection or reusing its token.

### Naming and conflicts

| Return shape                  | File                            | Connection name(s)      |
| ----------------------------- | ------------------------------- | ----------------------- |
| single connection definition  | `agent/connections/accounts.ts` | `accounts`              |
| map `{ production, staging }` | `agent/connections/accounts.ts` | `production`, `staging` |

A map key must be a legal connection name: lowercase ASCII letters, digits, and dashes, starting with a letter, up to 64 characters. Map keys are bare; eve does not prefix them with the file slug. A dynamic connection overrides a same-named static connection. Two dynamic connection files cannot return the same name; namespace one map key to remove the ambiguity.

A connection owns its name and every name that starts with `<name>__`. When a dynamic connection renders, eve rejects it if its name is, or is the `__` prefix of, one of the agent's tools, subagents, current dynamic tools, or other connections. Dynamic tools and dynamic subagents get the same check when they render. The error names both sides.

## Dynamic tools

`render` returns a single `defineTool(...)`, a map of `defineTool(...)` entries, or `null` for no tools. Wrap every entry in `defineTool()`. Tool callbacks are ordinary code: `execute`, approval policies, `approvalKey`, `toModelOutput`, and Zod schemas with refinements and transformations all work, and they can close over the values `render` received. Dynamic tool executors receive the same `ToolContext` as static authored tools, including inline provider auth through `ctx.getToken(provider)` and `ctx.requireAuth(provider)`.

A process that has never seen the session renders the tools again from the session's kept selection or record, then runs the call. So a tool's callbacks reach live clients and services through imports or the values `render` receives, never through state that only the first process held.

### Calls that wait for approval

A call that waits for approval runs the tool the model was offered. Nothing evaluates while a turn waits, and an approved call runs before the next model call evaluates anything, so a change such as the caller's role takes effect on the calls the model makes after it. Authorization still happens when the call runs: if a change must stop a call that's already approved, check it in `execute`.

### Naming

| Return shape            | File                       | Tool name(s)      |
| ----------------------- | -------------------------- | ----------------- |
| single `defineTool`     | `agent/tools/analytics.ts` | `analytics`       |
| map `{ export, query }` | `agent/tools/tenant.ts`    | `export`, `query` |

A single return produces one tool named after the file slug, identical to a static tool. A map names each entry by its **bare key**, with no automatic slug prefix. If a bare name might collide, namespace the key yourself by including the prefix in the key, such as `{ "tenant__export": … }` for `tenant__export`.

A map key must be a legal tool name: ASCII letters, digits, underscores, and dashes, starting with a letter, up to 64 characters. A key cannot be `eve` or start with `eve__`, which eve [reserves](../concepts/built-in-tools#eve__search-eve__tool-and-eve__skill) for its built-in tools, and cannot be a connection's name or start with its `<name>__` prefix. eve rejects such a key when the tool renders.

### Conflicts

A dynamic connection, tool, or skill whose name matches an **authored** one **overrides** it, so a per-caller definition can replace a static capability by name. Workflow tools and subagents are the exception: a dynamic tool can't take one of their names. Two **dynamic** files of the same capability type returning the same name is an ambiguity and fails; namespace one of the keys to resolve it.

### Package dynamic tools in an extension

Prefer an [extension](../extensions) for reusable eve integrations. Extensions contribute a namespaced set of capabilities that consumers can override. A provider package can also return `defineTool()` values from a function the consumer's `render` calls: tools are ordinary code, so they need no build step or durable wrapper.

## Dynamic skills

A dynamic skills file decides which [skill](../skills) a caller can load. Return a `defineSkill(...)`, named after the file slug, a map of them, or `null`:

```ts title="agent/skills/team_playbook.ts"
import { defineDynamic, defineSkill } from "eve/skills";
import { PLAYBOOKS } from "../lib/playbooks";

export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.team ?? null,
  render: (team) => {
    const markdown = typeof team === "string" ? PLAYBOOKS[team] : undefined;
    return markdown ? defineSkill({ description: "The caller's team playbook.", markdown }) : null;
  },
});
```

The caller's team gets its own playbook advertised as a loadable skill; everyone else gets nothing.

Skills follow the same naming rule as tools: a single `defineSkill(...)` is named after the file slug, while a map names each entry by its bare key. Every name must use only ASCII letters, digits, underscores, and dashes, start with a letter, and have at most 64 characters. A dynamic skill overrides a same-named authored one; two dynamic skill files returning the same name fail.

A dynamic skill with `deferred: true` is left out of the dynamic skill announcement and isn't named in context. The model finds it with `eve__search` and loads it with `eve__skill({ name })`, like a static deferred skill.

A dynamic skill that returns only `markdown` never starts a sandbox: eve keeps its instructions in session state and returns them when the model loads the skill. When the skill also has `files`, eve writes the package to the sandbox skill root, and again when its contents change or the session gets a new sandbox. A changed package replaces the previous directory, so files omitted from the new result are removed. Files that `render` makes are rendered again where a sandbox needs them, and the session keeps only their revision. Files that `record` returns are data, so the session keeps them, within the 1 MB record limit. Ship large files with the deployment and return them from `render`.

## Dynamic instructions

A dynamic instructions file returns `defineInstructions({ content, role? })` built from the principal, tenant, channel, or external data. Omit `role` for system context:

```ts title="agent/instructions/persona.ts"
import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.attributes.plan ?? "free",
  render: (plan) =>
    defineInstructions({
      content: `The caller is on the ${plan} plan. Match the depth of your answers to it.`,
    }),
});
```

A system instruction is part of every model call while the session selects it, and stays outside history. A selection that renders `null` or blank content contributes nothing.

Use `role: "user"` when the value is application or user context that should become part of durable history:

```ts title="agent/instructions/brief.ts"
import { defineDynamic, defineInstructions, perTurn } from "eve/instructions";
import { loadBrief } from "../lib/briefs";

export default defineDynamic({
  select: perTurn,
  record: async (_turn, ctx) => (await loadBrief(ctx.session.auth.current)) ?? null,
  render: (brief) => (brief === null ? null : defineInstructions({ content: brief, role: "user" })),
});
```

A user instruction joins the conversation once for each new selection, and stays there. One selected at the start of a turn comes before the message that started the turn. Here, `perTurn` appends the brief at the start of every turn, even when its text repeats. Selecting `null` later doesn't remove an instruction already in history; compaction and clear treat it as ordinary history.

Dynamic system content that changes frequently can reduce provider prompt-cache reuse. Prefer `select: once` for stable values, and refresh per turn only when the context must change. Cache behavior remains provider-specific.

## What to read next

- Conditionally expose a specialist → [Subagents](../subagents)
- Resolve caller-specific external services → [Connections](../connections)
- The static tool basics this builds on → [Tools](../tools)
- Act on session changes with side effects → [Hooks](./hooks)
- The built-in tools and how to override them → [Built-in tools](../concepts/built-in-tools)
- Authenticate a tool or connection to an external service → [Auth & route protection](./auth-and-route-protection)
- Durable per-session memory → [State](../concepts/state)
- Cross-session recall and provider-generated tools → [Memory](../memory)
