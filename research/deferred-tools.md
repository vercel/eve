---
issue: TBD
status: proposed
last_updated: "2026-10-06"
---

# Deferred tools and skills

## Summary

Agents tend to score better on evals when every tool and skill lives on the
main agent, so the model doesn't have to hand each specialized task to a
subagent. Large teams push that until the tool list and skill list fill the
context. A few hundred tool definitions cost tens of thousands of tokens on
every request, and the model starts picking the wrong tool. One popular MCP server alone,
Playwright, spends 13.7k tokens on 21 tools
([source](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)).

This doc proposes a catalog of deferred capabilities that the model reaches
through two fixed tools, `search` and `execute`:

```ts
search(opts: {
  query: string;
  limit?: number;
}): Promise<{
  results: Array<
    | { tool: string; description: string; signature: string }
    | { skill: string; description: string; path?: string }
  >;
  unavailable?: Array<{ connection: string; error: string }>;
}>;

execute(
  | { tool: string; input?: object }
  | { skill: string }
  | { code: string }, // code mode, later
): Promise<unknown>;
```

- **One opt-in.**
  - A tool sets `deferred: true` on `defineTool` or `defineWorkflowTool`.
  - A subagent sets `tool: "deferred"` on its `defineAgent`.
  - A skill sets `deferred: true` in its `SKILL.md` frontmatter or on
    `defineSkill`.

  Each works for static and dynamic entries. Connection tools are always
  deferred.

- **`search` and `execute` replace `connection_search`,
  `connection_execute`, and `load_skill`.** There is one catalog for
  everything, and no `skill_search`.
- **One dispatch path.** `execute` looks the entry up and runs it exactly
  like a direct call:
  - an inline tool runs inline;
  - a workflow tool starts its run;
  - a subagent starts its child session;
  - a connection tool calls its connection;
  - `execute({ skill })` loads a skill, deferred or not, with today's
    `load-skill` action.
- **Always registered.** Both tools exist in every session of every agent.
  So entries, static or dynamic, can join or leave the catalog at any step
  without changing the `tools` array.
- **Cache stable.** Catalog entries never enter the `tools` array, the system
  prompt, or a tool description. They are announced through one append-only
  listing, under the invariants of
  [cache-stable connection tools](./connection-execute.md).
- **Ready for code mode.** The `{ code }` variant is reserved. Code mode adds
  it later without changing the shape.

```ts
export default defineTool({
  description: "Refund a paid Stripe invoice.",
  deferred: true,
  inputSchema: z.object({ invoiceId: z.string() }),
  async execute({ invoiceId }) {
    /* ... */
  },
});
```

```md title="agent/skills/pdf-forms/SKILL.md"
---
description: Fill and validate PDF forms.
deferred: true
---
```

This supersedes the model surface in `connection-execute.md`: the two
connection tools, their nested actions, and the connection listing. The
connection result format, sign-in, approval, and instance pinning carry over.

## Current state

- **Every tool is advertised.** Each static tool and each subagent tool the
  session can use goes into the provider `tools` array on every step
  (`harness/advertised-tools.ts`). The only filters are subagent visibility
  (`availableInSubagents`, `rootOnly`) and `tool: false`.
- **The harness already knows each tool's kind.** Every entry in the
  `HarnessToolMap` carries `behavior.handling` (`tools/behavior.ts`):
  - `dispatch` to `workflow-tool-call`, `subagent-call`,
    `remote-agent-call`, or `self-agent-call`;
  - `provider-tool`;
  - nothing, for a plain tool with an inline `execute`.

  Coordination reads it to decide whether a call runs inline, starts a
  workflow run, or starts a child session (`harness/coordination.ts`).
  Dynamic subagents join the same map each step
  (`buildHarnessToolsWithDynamicSubagents`).

- **Connection tools are the exception.** They aren't harness tools.
  `connection_execute` (`execution/tools/connection-tools.ts`) is a
  `defineTool` closure that calls the connection and reports a nested
  `<connection>__<tool>` action. That pattern can't reach workflow tools or
  subagents, because the harness has to see their call to park the turn and
  start the run.
- **Connections already have the cache machinery this doc reuses.**
  - The listing is a `context.state` announcement
    (`execution/connection-announcement.ts`, `harness/announcements.ts`).
  - Search returns TypeScript signatures
    (`runtime/connections/tool-signature.ts`), ranked by
    `execution/tools/connection-search-rank.ts`.
- **Every skill is listed.**
  - Static skills appear in the system prompt's "Available skills" section,
    with name, description, and file path (`formatAvailableSkillsSection` in
    `execution/skills/instructions.ts`).
  - Dynamic skills are re-announced as a full `context.state` list whenever
    they change (`context/dynamic-skill-lifecycle.ts`).
  - The model loads one with `load_skill({ skill })`, a framework action
    (`frameworkAction: "load-skill"`) that returns the skill's markdown.
    `load_skill` exists only when the agent declares skills.
- **Name clash.** Inside the harness, "deferred tool" currently means a
  workflow-backed tool, as in `Deferred tool "…" has no workflow.`
  (`harness/coordination.ts`, `harness/tool-loop.ts`,
  `execution/tasks/tool-entry-point.ts`). That internal term gets renamed to
  "workflow tool" (8 occurrences).

## Prior art

### AI SDK

Read in the versions eve pins: `ai@7.0.105`, `@ai-sdk/provider-utils@5.0.43`,
`@ai-sdk/anthropic@4.0.56`, and `@ai-sdk/openai@4.0.69`.

- **`deferLoading` and `toolSearch()`.** `BaseTool.deferLoading` hides a tool
  until `toolSearch()` finds it. `createToolSearchState` (`ai/dist/index.js`)
  keeps a `discovered` set in memory for one generation. Each step filters
  `activeTools` down to tools that aren't deferred plus the ones discovered so
  far. Search is word overlap on name and description, top five results, and
  returns `{ name, description }` with no schema.
- **It breaks the cache.** A tool the model finds is added to `tools` on the
  next step, and the whole cached prefix is lost. The only cache-stable path
  is code mode with `toolDiscovery: 'conversation'`. It also needs every
  definition before the generation starts and drops discoveries when the
  generation ends, which doesn't fit eve's durable step-by-step execution.
- **Provider-native search.**
  - Anthropic: `toolSearchRegex_20251119` and `toolSearchBm25_20251119` with
    `providerOptions.anthropic.deferLoading`. The `toolChanges` option on
    mid-conversation system messages also adds tools without losing the cache
    (beta `mid-conversation-tool-changes-2026-07-01`).
  - OpenAI: `openai.tools.toolSearch()` with
    `providerOptions.openai.deferLoading` and tool namespaces.
  - In all of these the provider runs discovery and the model calls the tool
    directly by name. All of it is specific to one provider and some of it is
    beta.

### opencode

Sources:
[`dev@83802d8`](https://github.com/anomalyco/opencode/tree/83802d800e1f05d8823f9e0a85cfaa580986d086)
and
[`v2@6bffe79`](https://github.com/anomalyco/opencode/tree/6bffe7932efa9adc36b74e389598daecb4b17ac1),
read but not run. Neither branch has `deferLoading`, `tool_search`, or
provider-native search.

- **`dev`.** Every MCP tool is a native `<server>_<tool>` definition, and
  `tools/list_changed` updates the array mid-session. Experimental code mode
  (`OPENCODE_EXPERIMENTAL_CODE_MODE`) replaces them with a single `execute`
  tool. Its description holds the catalog, up to a budget of about 2,000
  tokens, plus a `search()` helper, so a catalog change still changes `tools`.
- **`v2`.** Code mode is on by default. Tools set `codemode: false` to stay
  native: shell, read, edit, the skill and subagent tools, and MCP servers
  configured that way. Everything else is reachable only through `execute`,
  and calling those tools by name fails with "No tool named … is currently
  available". The `execute` description is fixed. The catalog arrives as an
  instruction baseline followed by appended diffs
  (`codemode/instructions.ts`, `session/instruction-state.ts`). Each child call
  runs the same permission check as a direct call (`tool/mcp.ts`).
- **What carries over:**
  - one catalog over local and MCP tools;
  - an entry point named `execute` with a fixed description;
  - `search()` and `tools.<ns>.<tool>()` inside programs;
  - an append-only catalog;
  - the same permission checks whichever way a tool is called.

### pi

Source:
[`pi-mono@636703a`](https://github.com/badlogic/pi-mono/tree/636703a0a4f2f4d8558d08f2308cb41109585bf5).
Built-in MCP, `tool_search`, and code mode shipped in 0.99.0, which reverses
pi's earlier "no MCP" position.

- **Per-tool exposure.** `coding-agent/src/core/extensions/types.ts` defines
  `ToolExposure` as `direct`, `model-only`, `codemode`, `deferred`, or
  `hidden`. MCP tools default to `codemode`. The `deferred` exposure routes a
  tool through `tool_search`.
- **Search activates matches.** `tool_search` uses BM25 over name,
  description, schema text, and namespace, and calls
  `setActiveTools([...active, ...matches])`. The model then calls the matched
  tools directly by name. To keep the cache, pi depends on provider support:
  - Anthropic: inline `tool_addition` blocks plus a `defer_loading`
    placeholder tool. Without the placeholder, pi measured a full cache miss on
    the first tool change.
  - OpenAI: `additional_tools`, or a synthetic `tool_search_call`.
  - Other providers: pi's own docs say the prefix can be invalidated.
- **Fixed search description.** It never lists the searchable tools, so it
  doesn't change as servers connect.
- **Skills** are listed by name, description, and path in the system prompt
  and read with the file tool. They aren't searchable.
- **Community adapters.** `pi-mcp-adapter` uses a single proxy tool,
  `mcp({ search })` then `mcp({ tool, args })`, which is the same shape as
  this design.

### What we take

| Question                   | AI SDK                    | opencode v2              | pi                           | This design               |
| -------------------------- | ------------------------- | ------------------------ | ---------------------------- | ------------------------- |
| Opt-in                     | `deferLoading`            | `codemode` (default on)  | `exposure: "deferred"`       | `deferred: true`          |
| One catalog with MCP       | No                        | Yes                      | Yes                          | Yes                       |
| How a found tool is called | Directly, next step       | `tools.x()` in `execute` | Directly, next step          | `execute`, same step      |
| `tools` array mid-session  | Grows                     | Fixed                    | Grows, except on 2 providers | Fixed                     |
| Catalog delivery           | Search result only        | Baseline + diffs         | Search result only           | Baseline + diffs          |
| Discovery state            | In memory, one generation | None                     | Session transcript           | None; search is stateless |

## Design

```text
             tools array (fixed for every session)
             ┌──────────────────────────────────────┐
             │ direct tools...   search   execute   │
             └──────────────────────────────────────┘
messages:  [system prompt, no catalog names]
           [context.state: catalog baseline]
           ... turns ...
           [context.state: catalog diff]          ← append only
           ... compaction ...
           [context.state: new baseline]

execute({ tool, input })                          ← model history only
  └─ resolve entry by name → dispatch as a direct call
       inline tool   → execute
       workflow tool → durable run (foreground parks, background returns a task)
       subagent      → child session (local, remote, or root copy)
       connection    → connection client ("linear__list_issues")

execute({ skill })                                ← model history only
  └─ resolve skill by name → load-skill action → the skill's markdown
```

### Authoring API

**Tools.** `deferred?: boolean` sits next to `availableInSubagents` in
`ToolDefinitionBase`, so `defineTool` and `defineWorkflowTool` both accept it.
It defaults to `false`.

```ts title="agent/tools/deploy_service.ts"
import { defineWorkflowTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Review and deploy a service.",
  deferred: true,
  approval: always(),
  inputSchema: z.object({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";
    /* ... */
  },
});
```

**Subagents.** A subagent's `tool` setting already controls whether the
subagent appears as a tool. It widens from `boolean` to
`boolean | "deferred"`. This applies to `defineAgent`, remote agents,
workspace agents, and dynamic subagent configs.

```ts title="agent/subagents/billing_specialist/agent.ts"
export default defineAgent({
  description: "Resolve billing disputes and refunds.",
  model: "anthropic/claude-sonnet-4.6",
  tool: "deferred",
});
```

- **What each value means:** `true` is a direct tool, `"deferred"` is a
  catalog entry, and `false` is not a tool at all.
- **On the root agent,** `tool: "deferred"` defers the built-in `agent`
  self-delegation tool.
- **Why `tool` and not a separate flag.** A separate `deferred` flag on
  `defineAgent` would allow the contradiction `tool: false, deferred: true`.
- **`ctx.agent(name)` is unchanged.** It resolves from the full registry
  whatever `tool` says.

**Built-in and extension tools** are deferred by spreading them, the same way
they're overridden today:

```ts title="agent/tools/bash.ts"
import { defineTool } from "eve/tools";
import { bash } from "eve/tools/bash";

export default defineTool({ ...bash, deferred: true });
```

**Dynamic entries.** `DynamicToolEntry` accepts `deferred`, and dynamic
subagent configs accept `tool: "deferred"`. Teams use this for catalogs that
depend on the tenant or the user:

```ts title="agent/tools/tenant.ts"
import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const actions = await loadTenantActions(ctx.session);
      return Object.fromEntries(
        actions.map((action) => [
          action.id,
          defineTool({
            description: action.description,
            deferred: true,
            inputSchema: action.inputSchema,
            execute: (input) => runTenantAction(action.id, input),
          }),
        ]),
      );
    },
  },
});
```

- **Same rules as direct dynamic entries.**
  - A map entry is named by its bare key, with the mount prefix added for an
    extension's resolver. Authors add their own prefix when they want one,
    such as `tenant__export`.
  - A dynamic tool still can't be a workflow tool.
  - An entry the resolver no longer returns can't be called: `execute`
    reports it as unknown and suggests the closest names.
- **Keys are validated.** Every dynamic entry name, direct or deferred, must
  match `TOOL_SLUG_PATTERN`. Today a bad key fails only when the provider
  rejects it, and a deferred name never reaches a provider. Checking it when
  the resolver returns it means any entry that works deferred also works
  direct.
- **Prefer session- or turn-scoped resolvers.** A `step.started` resolver
  whose deferred set changes every step appends a listing diff every step.
  The cache stays intact, but history grows.

**Skills.** `deferred?: boolean` joins the skill definition. It defaults to
`false` and is set in any of three places:

```md title="agent/skills/pdf-forms/SKILL.md"
---
description: Fill and validate PDF forms.
deferred: true
---
```

```ts title="agent/skills/release_notes.ts"
import { defineSkill } from "eve/skills";

export default defineSkill({
  description: "Write release notes from merged pull requests.",
  deferred: true,
  markdown: "...",
});
```

```ts title="agent/skills/tenant.ts"
import { defineDynamic } from "eve";
import { defineSkill } from "eve/skills";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const playbooks = await loadTenantPlaybooks(ctx.session);
      return Object.fromEntries(
        playbooks.map((playbook) => [
          playbook.id,
          defineSkill({
            description: playbook.description,
            deferred: true,
            markdown: playbook.markdown,
          }),
        ]),
      );
    },
  },
});
```

- **What `deferred` changes.** A deferred skill leaves the system prompt's
  skill section and the dynamic skill announcement. It is found with
  `search` and loaded with `execute({ skill })`. Everything else is the same
  as today: its markdown, its package files in the sandbox, its activation,
  and its eval facts.
- **Dynamic skills keep their rules.** They resolve on `session.started` and
  `turn.started` only. A map entry is named by its bare key, with the mount
  prefix added for an extension's resolver. A dynamic skill still overrides a
  same-named authored skill.
- **Names are validated.** Skill names, static and dynamic, must match
  `TOOL_SLUG_PATTERN`. There is no check today, and dynamic skill keys
  aren't checked at all.

**Connection tools** are always catalog entries. There is no switch to make
them direct; this matches what `connection_search` does today.

**Provider tools can't be deferred.** These are tools with
`behavior.handling.kind === "provider-tool"`, such as native web search. The
provider has to see their definition, so deferring one is a compile error.

### The catalog

Every entry has one flat name: the same name it has, or would have, as a
direct tool. `__` is the only namespace separator, as it is everywhere in eve
today.

| Entry         | Source                                                                | Name                                            | Lookup                                                                                 |
| ------------- | --------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Inline tool   | `deferred: true` on a static or dynamic tool with an inline `execute` | `refund_invoice`, `crm__search`, `tenant__sync` | Harness tools for the step, no dispatch handling                                       |
| Workflow tool | `deferred: true` on `defineWorkflowTool`                              | `deploy_service`                                | Harness tools for the step, `workflow-tool-call`                                       |
| Subagent      | `tool: "deferred"` on a local, remote, dynamic, or root-copy agent    | `billing_specialist`, `crm__reviewer`           | Harness tools for the step, `subagent-call`, `remote-agent-call`, or `self-agent-call` |
| Connection    | Every tool of every connection, after `tools.allow` and `tools.block` | `linear__list_issues`, `crm__api__list_issues`  | The owning connection, then its `getToolMetadata()`                                    |
| Skill         | `deferred: true` on a static or dynamic skill                         | `pdf-forms`, `crm__playbook`                    | Authored skills and the dynamic skill manifest, under the `skill` key                  |

- **Owners.** A `__` prefix names the entry's owner:
  - an extension mount: `crm__search`;
  - a connection: `linear__list_issues`;
  - a memory slot: `<slot>__<key>`.

  Owners nest. An extension mounted as `crm` with `connections/api.ts`
  contributes connection `crm__api`, whose tools are `crm__api__list_issues`.
  A prefix an author adds by convention, such as `tenant__export`, has no
  owner.

- **A connection owns its name and its `__` prefix.** No tool, subagent,
  memory tool, extension contribution, or other connection may be named
  `linear` or start with `linear__` while connection `linear` exists.
  - **Only connections need the rule.** They are the only entries eve can't
    list up front, because listing their tools needs a network call and maybe
    a sign-in. Every other name is known, and exact duplicates are already
    errors.
  - **Checked on names alone.** eve never lists a connection's tools to check
    it.
  - **When it's checked.** Static names are checked at compile time. Dynamic
    connections, tools, subagents, and memory tools are checked when they
    resolve. The entry that introduces the conflict is rejected with an error
    naming both sides, for example:

    ```text
    Dynamic tool "linear__sync" starts with "linear__", which belongs to connection "linear". Rename the map key.
    ```

  - **Nested connections.** Connection `acme__crm` conflicts with connection
    `acme`. Without the rule, `acme__crm__list` could mean connection `acme`
    with tool `crm__list`, or connection `acme__crm` with tool `list`.
- **Routing.** `execute({ tool })` first looks for an exact match among the
  step's harness tools: authored and dynamic tools plus static and dynamic
  subagents, in the precedence direct calls use today. Otherwise it finds the
  connection whose `<name>__` starts `tool`, and the rest is that
  connection's tool name, checked against its metadata.
  - The ownership rule allows at most one candidate, so the order of the
    checks never changes the result.
  - The rest of the name is never split again, so MCP tool names work
    whatever characters they contain.
- **Dispatch is decided before anything runs.** For harness entries, the
  dispatch handling is on the definition, which the harness already has. A
  name under a connection's prefix is always a connection call. So
  coordination can decide whether a call parks without any network call.
- **Deferring never renames.** The model sees the same name in its tool list,
  in `search` results, in `execute` input, and in history. All of these keep
  working whether a tool is direct or deferred: protocol action names,
  approvals and `approvalKey`, evals, hooks, `toolResultFrom`, display titles,
  and extension overrides such as `agent/tools/crm__search.ts`.
- **Namespaces are never parsed.** The ownership check compares names
  against connection names, and a connection entry knows its connection,
  which gives labels such as `Linear: List issues`. Nothing splits a name at
  `__`. Code mode will record owners on each entry for program paths such as
  `tools.crm.api.list_issues`; a convention prefix with no owner stays part
  of the name, as in `tools.tenant__export`.
- **Scope.** The catalog holds only entries advertised to the current
  session, so a child session never sees a tool with
  `availableInSubagents: false`.
- **Skills have their own key.** A skill is addressed as `{ skill }`, never
  `{ tool }`. Skills and tools keep separate name spaces, as they have today,
  so a skill can share a name with the tool it documents. The connection
  ownership rule applies only to `tool` names.

### Model surface

**`search`**

- **Input:** `{ query, limit? }`.
  - `limit` defaults to 20 and is capped at 50.
  - `query` is required and must contain a word. The listing already names
    every tool, agent, skill, and connection, so there is no need for a
    query-less browse. A connection's name as the query, such as `linear`,
    lists that connection's tools first.
  - **Namespace queries.** A query whose first word contains `__` searches one
    namespace: everything before its last `__`, with trailing underscores
    trimmed. The namespace only filters. `search` keeps names under
    `<namespace>__` and anything named exactly the namespace, such as a
    connection's sign-in entry, then ranks them by the whole query. So
    `linear__list_issues` still finds the `linear` sign-in entry when Linear
    needs sign-in, and an exact name that contains `__` still ranks first.
    Connection ownership means no tool outside a connection uses its
    prefix, so `search` lists only the connections that can own names in
    the namespace (`linear`, or `crm__api` under an extension mounted as
    `crm`). Other connections make no network call and don't appear in
    `unavailable`. A namespace that matches nothing fails with the closest
    connection names instead of returning an empty list. Characters that
    can't appear in a name, such as a leading `^`, are ignored, and regex
    isn't supported. The description tells the model to use this when it
    already knows the connection or a name from the listing, a result, or
    an error.
  - There is no connection filter and no sign-in flag. The query already
    selects a connection, and sign-in is an `execute` call.
  - There is no paging and no match count. `search` returns the best matches
    up to `limit`, and the model narrows the query or raises `limit` for more.
    Paging and counts assume a fixed, countable match list, which a future
    search that asks a model to choose entries wouldn't have.
- **Async.** `search` returns a promise, so the way it picks results can
  change, for example to a decision model, without changing its signature.
- **Result:** `{ results, unavailable? }`.
  - A tool entry is `{ tool, description, signature }`. `tool` is the exact
    name to pass to `execute`.
  - `signature` is TypeScript rendered from the input and output schemas by
    `renderToolSignature`, which moves to a shared module. It is more compact
    than JSON Schema, includes the output type, and is what a code-mode
    program calls.
  - Results don't say whether a tool is inline, a workflow, a subagent, or a
    connection tool. The call is the same for all of them. Notes eve appends
    to a direct tool's description, such as the `endsTurn` sentence or
    background-task guidance, go at the end of `description` instead.
  - A skill entry is `{ skill, description, path? }`. `path` is the skill's
    `SKILL.md` under the skills root, present when the skill has package
    files. It is the same path the skill section shows for a skill that isn't
    deferred, so relative references inside the skill still resolve.
  - Tools and skills rank together, so one query such as "fill a PDF form"
    can return a `pdf_fill` tool and a `pdf-forms` skill.
  - A connection whose tools can't be listed until the user signs in appears
    as a tool result named after the connection, such as
    `{ tool: "linear", description: "Sign in to use the Linear tools: …" }`.
  - `unavailable` reports only connections that failed to list or can't
    start an interactive sign-in.
- **Ranking.** Matches rank in tiers, and an exact name always ranks first:
  1. the query's words equal the entry's full name, such as
     `linear__create_issue`;
  2. they equal the name without its connection prefix, such as
     `create_issue`;
  3. they start the entry's connection name and the full name, so `linear`
     returns the `linear` connection's tools;
  4. they start the entry's name, with the last word allowed to be partial,
     such as `create_iss`;
  5. keyword matches, weighted by field: the name, then the connection name,
     input property names, the description, and last property descriptions
     and the connection description.

  A score breaks ties within a tier, then the connection name, then the
  entry name. A skill has only a name and a description to match. `execute`'s
  closest-name suggestions use the same ranking.

- **Sign-in.** `search` never prompts. It lists a connection that needs
  sign-in as a result, and `execute({ tool: "<connection>" })` asks the user
  to sign in.
- **Description.** Fixed for each eve version. It names no entry. It says
  that `search` finds the agent's own tools and services, not web pages, so
  the model doesn't use it in place of `web_search`.

**`execute`**

- **Input:** `{ tool: string, input?: object }` or `{ skill: string }`.
  `input` defaults to `{}`.
- **Wire schema.** The provider receives one flat object schema,
  `{ tool?, input?, skill? }`, because Anthropic rejects `oneOf`, `anyOf`,
  and `allOf` at the top of a tool's input schema
  ([example](https://github.com/anthropics/claude-code/issues/4886)). eve
  requires exactly one of `tool` or `skill`, and `input` only with `tool`. It
  returns a clear error otherwise. The union exists only in the docs and the
  TypeScript types. Code mode later adds `code` as another optional property.
- **Any entry, no prior search.** It calls any catalog entry by name, whether
  or not it was searched for. There is no discovered set to persist or replay.
- **Loads every skill.** `execute({ skill })` loads any skill the session can
  see, deferred or not. The skill section of the system prompt and the
  dynamic skill announcement tell the model to load listed skills this way,
  and `load_skill` is removed.
- **Validation.** For a tool, eve checks `input` against the entry's input
  schema before dispatching, because the provider never saw that schema.
  Failures come back as data the model can act on:
  - An unknown tool or skill lists the closest names of the same kind.
  - A direct tool returns `"<name>" is in your tool list; call it directly.`
  - Invalid input returns the entry's `signature`.
  - A skill name that matches a connection says to find its tools with
    `search({ query: "<connection>" })`. This hint moves over from
    `load_skill`.
- **Sign-in.** A connection's own name is an entry.
  `execute({ tool: "linear" })` finishes a pending sign-in or starts one, the
  same way a call to one of its tools does, and parks until the user signs
  in. It then says the connection's tools can be searched. When the tools
  are already listable, it only confirms. It has no approval, and its label
  is `Connect Linear`. Every path that finishes a sign-in, whether in
  `search`, a tool call, or this entry, goes through one helper.
- **Description.** Fixed for each eve version. It tells the model to use
  names exactly as `search` returns them, to load skills with `skill`, and to
  prefer connected services over web search or general knowledge. That last
  sentence moves over from `connection_search`.

**Both tools**

- **Always present.** Both exist in every session of every agent, root and
  child, whether or not the catalog has entries. This is what lets dynamic
  entries join the catalog on any step: the `tools` array never has to change
  to reach them. A rule like "present while the catalog is non-empty" would
  flip the array the first time a resolver returns a deferred entry.
- **Cost of an empty catalog.** Two fixed definitions, about the size of
  today's two connection tools, cached with the rest of the prefix. No
  listing is appended, and `search` returns `{ results: [] }`.
- **Closed and reserved.** `agent/tools/search.ts`,
  `agent/tools/execute.ts`, and the framework module that provides them are
  compile errors in every agent, as the connection tool slots are today. The
  error tells the author to rename the file. Extension tools are prefixed, so
  an extension's `tools/search.ts` (`crm__search`) is unaffected. A
  connection can't take the name of a tool eve adds at runtime, such as
  `search` or `execute`, because its own name is the entry that signs in to
  it. Static connections fail at compile time, and dynamic ones when they
  resolve.
- **`defaultTools: false`** doesn't remove them.

### Dispatch

An `execute` call is dispatched as if the model had called its entry
directly. The harness resolves the entry once per call
(`resolveCatalogEntry(toolCall, tools)`) and uses it everywhere the harness
looks a call up by name. Model history is the only place that keeps
`execute`.

| Concern                        | Harness entries (inline, workflow, subagent)                                        | Connection entries                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Action name on the protocol    | The entry's name                                                                    | `<connection>__<tool>`, as today                                                 |
| Approval                       | The entry's `approval` and `approvalKey`                                            | The connection's `approval`, keyed `<connection>__<tool>`, with instance pinning |
| Execution                      | Inline `execute`, a workflow run, or a child session, chosen by `behavior.handling` | The connection client, with result conversion and auth parking unchanged         |
| `toModelOutput`, `endsTurn`    | The entry's                                                                         | The connection's file-part projection                                            |
| `ctx.toolName`, `ctx.callId`   | The entry's name and the model's call id                                            | n/a                                                                              |
| Labels, hooks, audience policy | The entry                                                                           | `Linear: List issues`, as today                                                  |
| Eval assertions                | `t.calledTool("deploy_service")`, `t.calledSubagent(...)`                           | `t.calledTool("linear__list_issues")`, unchanged                                 |
| Model history                  | `execute` call and result, same call id                                             | Same                                                                             |

- **One name everywhere.** The name the model passes to `execute` is also the
  protocol action name, the approval `toolName` and key, and the eval
  assertion name. For connection tools that is today's `<connection>__<tool>`.
  So existing approval policies, recorded "always approve" decisions,
  `toolResultFrom`, and eval assertions keep working.
- **Harness entries need nothing new.** Once a call resolves to its entry,
  the harness dispatches it exactly like a direct call, because the dispatch
  handling is already on the definition.
  - A foreground workflow tool parks the turn and starts its run.
  - A background workflow tool returns its task receipt, and `task_wait` and
    `task_cancel` work on the `taskId`.
  - A subagent starts its child session, and the child's `session.started`
    records the model's call id as `parentCallId`.
- **Connection entries become harness definitions.** At resolve time, eve
  builds a harness definition from the connection's metadata that is never
  advertised: an `execute` that calls the client, the connection's approval,
  and its model-output projection. The code is today's
  `executeConnectionTool`, `connection-approval.ts`, and `tool-result.ts`,
  moved behind that definition. The definition is built only after the call
  is already known to be a connection call, so the network lookup it needs
  never delays the decision to park.
- **Skill entries run the `load-skill` action.** `execute({ skill })` becomes
  the same runtime action `load_skill` produces today
  (`kind: "load-skill"`). So protocol events, activation, package files
  under the skills root, the `Load skill: …` label, and `t.loadedSkill(...)`
  are unchanged. History holds an `execute` call whose result is the skill's
  markdown. Loading needs no approval, as today.
- **No nested actions.** Every entry, including a connection tool, is
  reported as the call itself. The nested-action helper and the tool-call
  action's `parentCallId` field lose their only producer and are removed.
  Code mode adds the field back for calls made from a program.
- **`execute` inside the AI SDK.** The AI SDK decides per tool name whether
  to run a tool, so `execute` always has a run function. For an inline entry
  it runs the entry's own `execute`. For a workflow tool or subagent it
  returns a dispatch marker that the harness strips from the step, then
  dispatches the resolved call through the existing workflow and
  child-session path. The marker is hidden from telemetry and lives in one
  module.
- **Harness seams.** These are the places that look up by tool name today:
  - `buildToolApproval` and `buildToolSet` (`harness/tools.ts`);
  - `createRuntimeActionRequestFromToolCall`,
    `createCoordinationRequestFromToolCall`, subagent dispatch, and the
    `load-skill` mapping that `frameworkAction` drives today
    (`harness/coordination.ts`);
  - label and `endsTurn` lookup in `prepareModelTools`
    (`harness/tool-loop.ts`);
  - the history writer, which must record `execute` rather than
    `result.toolName`, `subagentName`, or `load_skill`.

  This is a change to the harness, and it is needed: without it, workflow
  tools and subagents can't be deferred, and skills can't load without
  `load_skill`.

- **Never AI SDK `deferLoading`.** eve builds its AI SDK tools itself and
  never sets `deferLoading` or passes `toolSearch()`. Either one would bring
  back the growing `tools` array.

### Catalog listing

One announcement under the key `catalog` replaces the connection listing.

- **Baseline.** On a session's first model step, eve appends one
  `context.state` message. It lists deferred tools, subagents, and skills by
  name, and connections by name and description. Each group is sorted.
- **Skills that aren't deferred stay where they are:** static skills in the
  system prompt's skill section, dynamic skills in their announcement. Only
  the load instruction in both changes, to `execute({ skill })`.
- **Why connection tools aren't listed by name.** Listing them would mean
  connecting to every server, and possibly asking for sign-in, at session
  start.
- **Diffs.** Any of these changes appends a diff, or the full listing again
  if that is shorter:
  - a dynamic resolver adds or drops a deferred tool, subagent, or skill;
  - a dynamic connection resolves;
  - the session upgrades to a new deployment.

  The renderer is today's connection diff, extended to four groups. It also
  says which entries must no longer be called. Deferred dynamic skills get
  diffs, where today's dynamic skill announcement re-renders the full list.

- **After compaction,** the next step appends a fresh baseline.
- **Names only for local entries.** Descriptions and signatures come from
  `search`. At roughly 5 tokens per name, 300 entries cost about 1.5k tokens,
  cached once per session.
- **Empty catalog,** no message.

```text
More tools and skills are available than your context shows. Find them with search, call tools with execute({ tool, input }), and load skills with execute({ skill }).
Tools: deploy_service, refund_invoice, stripe_list_disputes
Agents: billing_specialist, researcher
Skills: pdf-forms, release_notes
Connections, whose tools are named <connection>__<tool>; search one connection's tools with "<connection>__":
- linear: Linear issues and projects
- petstore: Pet store inventory API
```

## Cache invariants

1. **Fixed tools.** The `tools` array is identical on every step of a
   session: same names, descriptions, schemas, and order. Catalog changes,
   static or dynamic, never touch it, because `search` and `execute` are
   always present.
2. **No session-specific text** in the system prompt or any tool description.
3. **Append-only history.** Listing changes only append messages, and earlier
   messages are never rewritten.
4. **No system-message fallback.** Announcements are always messages
   appended to history. They never fall back to the system prompt, including
   on the step that runs approved calls.
5. **Deterministic rendering.** Listings are sorted, and a signature is a
   pure function of its schema, so the same entry always renders the same
   text. `search` renders signatures only for the results it returns.
6. **Calling an entry adds nothing.** An `execute` call, skill load,
   approval, park, sign-in, child session, or resume never adds a definition. That is exactly
   where AI SDK `toolSearch()` and pi's activation path lose the cache.

## Implementation

### Principles

The result must read as if eve had been designed around the catalog from the
start.

1. **Expect a net deletion.** This work replaces three model surfaces
   (`connection_search`, `connection_execute`, `load_skill`) and the special
   cases each one grew. It should remove more code than it adds.
2. **One path per job.** Each job in the table below has exactly one
   implementation. A direct call and an `execute` call share everything after
   name resolution. No adapter, fallback, or second branch does the same work
   another way.
3. **No compatibility layer.** There are no aliases for removed tools, no
   flags that restore old behavior, and no code or comments that mention the
   old surface. Pre-1.0, eve prefers the breaking change.
4. **Old tests are deleted, not ported.** A test that covers a removed path
   is deleted along with the path. Tests for the new design are written fresh
   in the testing PR, against the new surface. Old assertions are never
   adjusted to fit.
5. **Generalize, then delete the original.** Code that survives, such as the
   ranker, the signature renderer, connection approval, and instance pinning,
   moves to where the unified path needs it. No copy stays behind under its
   old name.

### One path per job

| Job                       | Today                                                                                                                                       | After                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Find a capability by name | Authored tool map, dynamic tool list, dynamic subagent merge, presentation map (`prepareModelTools`), and `connection_execute`'s own lookup | One table of the step's entries, built once per step and used both to advertise direct tools and to resolve `execute` |
| Run a call                | AI SDK `execute`, workflow dispatch, subagent dispatch, the `load_skill` `frameworkAction`, and the `connection_execute` closure            | Resolve the entry, then dispatch on its handling, the same for direct and `execute` calls                             |
| Approve a call            | Per-tool approval functions on AI SDK tool objects, plus connection approval delegated through `connection_execute`                         | The resolved entry's approval, for every call                                                                         |
| Announce state            | A dedicated `availableSkills` field and the keyed announcements (`harness/current-messages.ts`)                                             | Keyed announcements only: `catalog`, plus skills that aren't deferred                                                 |
| Load a skill              | `load_skill`, the `frameworkAction` marker, and reserved-name handling in the subagent registry                                             | `execute({ skill })` to the `load-skill` action                                                                       |
| Report a call             | An action, plus nested actions for connection calls                                                                                         | One action per call, named for the entry                                                                              |
| Label a call              | Entry labels, plus `connection_execute` special cases in `toolCallDisplayName`, the dev TUI, and the channel task card                      | Entry labels                                                                                                          |
| Mock model                | Special handling and skill selection for `load_skill` (`runtime/agent/mock-model-*`)                                                        | The mock model calls `search` and `execute` like a real one                                                           |

### Deletion inventory

- **Connection tools.** `execution/tools/connection-tools.ts`,
  `execution/tools/connection-target.ts`, `tools/framework/connection-tools.ts`,
  `execution/connection-announcement.ts`, and the connection slots in
  `compiler/default-tool-policy.ts`.
  - `connection-search-rank.ts` and `runtime/connections/tool-signature.ts`
    move to the catalog.
  - `connection-approval.ts` moves behind the connection entry's definition.
- **Nested actions.** `harness/nested-actions.ts` and its callers in
  `harness/emission.ts` and `harness/step-hooks.ts`, plus their rendering in
  the dev TUI trace view and the channel task card, and the tool-call
  action's `parentCallId` field with its span attribute.
- **`load_skill`.** `execution/tools/load-skill.ts`,
  `tools/provided/load-skill.ts`, `public/tools/load-skill.ts`, the
  `eve/tools/load_skill` export, its framework source registration, the
  `load-skill` value of `frameworkAction`, `LOAD_SKILL_TOOL_NAME`, and its
  reserved-name entry in `runtime/resolve-agent-graph.ts`. An authored
  `agent/tools/load_skill.ts` becomes an ordinary tool. The `load-skill`
  action kind stays, because the protocol, traces, and `t.loadedSkill` report
  skill loads with it.
- **Skill announcement channel.** `PendingSkillAnnouncementKey`, the
  `availableSkills` announcement field, and its history state. Dynamic skills
  use a keyed announcement instead.
- **Special cases.** Every branch that names `connection_search`,
  `connection_execute`, or `load_skill`, including the TUI tool
  presentation, the channel task card, `load_skill`'s connection hint (which
  moves to `execute`), and the mock model.
- **Internal naming.** The harness's "deferred tool" for workflow-backed
  tools becomes "workflow tool".
- **Tests.** Every unit, integration, and e2e test for the paths above,
  deleted in the PR that removes the path. That is 18 unit and integration
  test files and 23 tracked e2e files today, led by
  `execution/tools/connection-tools.test.ts`,
  `execution/tools/load-skill.test.ts`,
  `execution/connection-announcement.test.ts`, the connection evals in
  `agent-openapi-swagger` and `agent-workflow-tools`, and the `load_skill`
  evals in `agent-skills` and `extensions`. A test file that also covers
  surviving behavior loses only the removed cases.

### Pull requests

Three stacked PRs. The first two hold all of the implementation and add no
tests. The third holds all of the new tests.

| PR            | Scope                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [1/3] Catalog | Naming groundwork (connection prefix ownership, key and name validation, the internal rename); `deferred` on tools and workflow tools; `tool: "deferred"` on subagents; dynamic entries; `search` and `execute`; the step entry table and call resolution; the catalog listing; connection tools as entries; removal of the connection tools and nested actions |
| [2/3] Skills  | `deferred` in frontmatter and `defineSkill`, static and dynamic; skill results in `search`; `execute({ skill })`; removal of `load_skill` and the skill announcement channel                                                                                                                                                                                    |
| [3/3] Tests   | Every new test, listed below. Fixes the tests surface go back into [1/3] or [2/3] before the stack merges.                                                                                                                                                                                                                                                      |

- **The stack merges together.** [1/3] and [2/3] delete the old e2e evals
  with the paths they cover, and [3/3] adds the new ones. So [1/3] and [2/3]
  pass unit tests on their own, but the e2e suites are only meaningful with
  [3/3] stacked on top.
- **Docs and changesets go with the implementation.** [1/3] and [2/3] each
  update the docs for the behavior they change and carry a `minor`
  changeset.

## Tests and rollout

Everything in this section lands in [3/3].

- **Captured-request unit test.** It drives one session through each entry:
  - a `search`, then `execute` of an inline tool;
  - a foreground workflow tool that parks and resumes;
  - a background workflow tool;
  - a deferred subagent;
  - a connection tool that parks for sign-in;
  - a connection listed for sign-in, then `execute` of its name;
  - a dynamic connection resolving;
  - a dynamic deferred tool and a dynamic deferred subagent appearing
    mid-session, then one of them disappearing;
  - a `search` that returns a tool and a skill with the same name, then
    `execute({ skill })` for a deferred static skill with package files;
  - a deferred dynamic skill appearing on `turn.started`, then loading;
  - `execute({ skill })` for a skill that isn't deferred;
  - a catalog change on the step that runs an approved call;
  - compaction.

  It asserts all six invariants. A second case covers an agent with an empty
  catalog: both tools are present and no listing is appended.

- **E2E: a new `agent-deferred-tools` fixture.** About 40 deferred entries:
  inline tools, a workflow tool with approval, a background workflow tool, a
  deferred subagent, deferred static and dynamic skills, a session-scoped
  dynamic resolver returning deferred tools, and the self-contained petstore
  OpenAPI connection.
  - World suites with the mock model: approval keyed to the entry, the
    workflow tool parking and resuming, the background task receipt, the
    subagent's child session, a deferred skill loaded with `t.loadedSkill`,
    and a misspelled name corrected from the suggestion.
  - Real-model suite: cache reads on the steps after discovery, following
    `agent-prompt-cache`.
- **New evals in the existing fixtures.** `agent-openapi-swagger`,
  `agent-workflow-tools`, `agent-skills`, and `extensions` get new evals
  written against `search` and `execute`. They cover what the deleted evals
  covered: connection approval, sign-in, dynamic connections, MCP result
  content, input validation, dynamic skills, skill overrides, and extension
  skills. They are written from the behavior, not ported from the old files.
- **Unit coverage for rules whose old tests were deleted.** Subagent
  visibility in the step catalog, the task tools offered per session,
  connection prefix ownership at compile and resolve time, dynamic tool and
  subagent collisions (including the `tool: false` wrapper pattern),
  connection input validated before approval, and listing failures that
  aren't sign-in.
- **Measurements.** Run one task set three ways:
  1. all tools and skills direct,
  2. long-tail tools and skills deferred,
  3. long-tail tools and skills in subagents.

  Compare task success, input tokens, cache read ratio, and model calls, at a
  moderate tool count and at a large one.

- **Ship gate.**
  - Arm 2 matches arm 1 on success at the moderate count and beats it at the
    large count.
  - Arm 2 beats arm 3 on success.
  - Connection and skill evals don't regress.
  - Agents with an empty catalog don't regress, now that every agent carries
    the two tools.
  - The model doesn't call `search` for web questions on agents that have
    `web_search`.
  - No cache regression after discovery.
- **Later, gated by evals.** Descriptions or signatures in the listing, up to
  a token budget, as opencode v2 does.
- **Docs,** updated in [1/3] and [2/3]:
  - `tools/overview`: deferring a tool, and which tools to defer (keep
    frequently used tools direct and defer the long tail).
  - `tools/workflows`, `subagents/*` (`tool: "deferred"`), and
    `concepts/built-in-tools` (`search` and `execute` instead of the
    connection tools and `load_skill`).
  - `skills`, `instructions`, `concepts/context-control`,
    `evals/assertions`, `reference/typescript-api`, and the team playbooks
    tutorial: deferring a skill and loading with `execute({ skill })`.
  - `connections/overview`, `connections/mcp`, `guides/dynamic-capabilities`
    (bare map keys, and the connection prefix rule), and `extensions` (the
    reserved names and how mount prefixes nest with connections).
- **Changesets,** one `minor` in each of [1/3] and [2/3]. Together they:
  - remove `connection_search`, `connection_execute`, and `load_skill`;
  - reserve `search` and `execute` in every agent;
  - reject names that start with a connection's prefix, which an existing
    agent may already have, such as connection `linear` beside a tool named
    `linear__sync`.

## Decisions and alternatives considered

| Decision            | Chosen                                                                                       | Rejected                                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool names          | `search` and `execute`                                                                       | `tool_search` and `tool_execute` (no collision risk, but the names don't match the functions inside a code-mode program)                                                                                                     |
| Search surface      | One `search` over every entry, connections included                                          | Keeping `connection_search` next to it (two places to look, two listings); a separate `skill_search`                                                                                                                         |
| Variants            | A key per variant: `tool` and `skill` now, `code` later                                      | One name space with markers such as `skill:pdf`; a `kind` field the model must echo                                                                                                                                          |
| Presence            | Always, in every session of every agent                                                      | Only while the catalog is non-empty (flips `tools` when a dynamic entry appears); an agent-level flag                                                                                                                        |
| Dynamic entries     | Deferrable, like static ones                                                                 | Static only (rules out per-tenant catalogs)                                                                                                                                                                                  |
| Opt-in              | `deferred: true` on tools and skills; `tool: "deferred"` on agents                           | An agent-level list of names; `deferLoading` (eve never loads the definition); pi's `exposure` enum                                                                                                                          |
| Discovery mechanism | Two fixed tools                                                                              | AI SDK `toolSearch()` or activation (grows `tools`); provider-native search (one provider at a time, partly beta)                                                                                                            |
| Dispatch            | Resolve to an entry, then dispatch it like a direct call                                     | A `defineTool` proxy (can't reach workflow tools or subagents; duplicates approval)                                                                                                                                          |
| Entry names         | One flat name, `__` as the only namespace separator, and connections own their prefix        | `<connection>.<tool>` (a second separator for one owner, and it renames connection tools); dots everywhere, encoded as `__` for providers (deferring would rename a tool); a separate `connection` argument (a two-part key) |
| Owners              | Recorded on each entry as data, added with code mode                                         | Recovered by splitting names at `__` (can't tell an owner from a convention prefix)                                                                                                                                          |
| Dispatch marker     | `execute` returns a marker for workflow and subagent entries; the harness strips it          | Renaming calls in a provider middleware (connection tools can't join the tool set without listing every connection, so they would need a second path)                                                                        |
| Search output       | TypeScript `signature`                                                                       | Raw JSON Schema (larger, and code mode needs the signature anyway)                                                                                                                                                           |
| Protocol shape      | Actions carry the entry's name; only history says `execute`                                  | An outer `execute` action with a nested entry action                                                                                                                                                                         |
| Search state        | Stateless; any entry can be executed                                                         | A durable discovered set that execution checks                                                                                                                                                                               |
| Listing             | One append-only listing: names, plus connection descriptions                                 | Nothing (the model can't tell when to search); full signatures (eval-gated)                                                                                                                                                  |
| Old paths and tests | Deleted with no compatibility layer; old tests deleted, and new tests written fresh in [3/3] | Aliases or flags for removed tools; porting old tests to the new surface; tests spread across the implementation PRs                                                                                                         |
| Loading skills      | `execute({ skill })` for every skill; `load_skill` is removed                                | Keeping `load_skill` beside `execute` (two ways to load); `load_skill` only for skills that aren't deferred (the model must know which kind it has)                                                                          |

## Later: code mode

Code mode adds `execute({ code })`. The rest of this design carries over:

| This design                    | Code mode                                                        |
| ------------------------------ | ---------------------------------------------------------------- |
| `search(opts)` tool            | `search(opts)` inside the program, same result shape             |
| `execute({ tool, input })`     | `tools.deploy_service(input)`, `tools.linear.list_issues(input)` |
| `execute({ skill })`           | Loading a skill from the program                                 |
| One action per `execute` call  | One nested action per call, with `parentCallId` added back       |
| Approval on the model's call   | Approval on the nested action, parking mid-program               |
| Catalog listing                | Unchanged                                                        |
| Signatures in `search` results | The types the program is written against                         |

- `execute({ tool, input })` is a one-call program, so both forms share one
  dispatch path.
- Each entry records its owners, and program paths come from that record,
  not from splitting names: `linear__list_issues` is `tools.linear.list_issues`,
  `crm__api__list_issues` is `tools.crm.api.list_issues`, and
  `tenant__export`, which has no owner, is `tools.tenant__export`.
- The `code` property appears only when code mode is on. That is fixed per
  agent and eve version, never per step, so the `tools` array stays stable.
- Names with `-` aren't JavaScript identifiers. A kebab-case connection such
  as `google-drive` is called as `tools["google-drive"].list_files(input)`.
