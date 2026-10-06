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
  query?: string;
  connection?: string;
  signIn?: boolean;
  limit?: number;
  offset?: number;
}): {
  results: Array<
    | { tool: string; description: string; signature: string }
    | { skill: string; description: string; path?: string }
  >;
  total: number;
  unavailable?: Array<{ connection: string; error: string; requiresSignIn?: true }>;
};

execute(
  | { tool: string; input?: object }
  | { skill: string }
  | { code: string }, // code mode, later
);
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
- **Namespaces are recorded, not parsed.** Each entry records its owners as
  data. The ownership check, labels such as `Linear: List issues`, and later
  code mode (`tools.crm.api.list_issues`) read that record. They never split
  a name at `__`. A convention prefix with no owner stays part of the name,
  as in `tools.tenant__export`.
- **Scope.** The catalog holds only entries advertised to the current
  session, so a child session never sees a tool with
  `availableInSubagents: false`.
- **Skills have their own key.** A skill is addressed as `{ skill }`, never
  `{ tool }`. Skills and tools keep separate name spaces, as they have today,
  so a skill can share a name with the tool it documents. The connection
  ownership rule applies only to `tool` names.

### Model surface

**`search`**

- **Input:** `{ query?, connection?, signIn?, limit?, offset? }`.
  - `limit` defaults to 10 and is capped at 50.
  - Leaving out `query` lists every entry. Pair it with `connection` to list
    one connection's tools.
  - `connection` and `signIn` mean what they mean on today's
    `connection_search`. They stay on search because sign-in applies to a
    whole connection, not one tool.
- **Result:** `{ results, total, unavailable? }`.
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
  - `unavailable` reports connections that need sign-in or failed to list,
    as it does today.
- **Ranking.** The `connection_search` ranker, generalized to any entry. It
  weights the name, then the connection name, input property names, the
  description, and last property descriptions and the connection
  description. A skill has only a name and a description to match.
- **Sign-in.** A plain search never prompts.
  `search({ connection, signIn: true })` starts authorization for that one
  connection.
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
    `search({ connection })`. This hint moves over from `load_skill`.
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
  listing is appended, and `search` returns `{ results: [], total: 0 }`.
- **Closed and reserved.** `agent/tools/search.ts`,
  `agent/tools/execute.ts`, and the framework module that provides them are
  compile errors in every agent, as the connection tool slots are today. The
  error tells the author to rename the file. Extension tools are prefixed, so
  an extension's `tools/search.ts` (`crm__search`) is unaffected.
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
  reported as the call itself. The nested-action helper loses its only caller
  and is removed. The `parentCallId` protocol field stays for code mode.
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
Connections:
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
4. **No system-message fallback.** If the last message is an approval
   response, the announcement waits for the next step.
5. **Deterministic rendering.** Listings and signatures are sorted and
   memoized per compiled tool or connection instance.
6. **Calling an entry adds nothing.** An `execute` call, skill load,
   approval, park, sign-in, child session, or resume never adds a definition. That is exactly
   where AI SDK `toolSearch()` and pi's activation path lose the cache.

## Removed

- `connection_search` and `connection_execute`, their framework module
  (`tools/framework/connection-tools.ts`), and their reserved slots, which
  `search` and `execute` take over.
- `load_skill`: its default tool slot, the `eve/tools/load_skill` export, and
  the `frameworkAction: "load-skill"` marker. `execute({ skill })` replaces
  it. An authored `agent/tools/load_skill.ts` becomes an ordinary tool.
- Nested actions for connection calls, and the nested-action helper.
- The `connections` announcement, replaced by `catalog`.
- References in `load_skill`'s not-found error, the skill section's load
  instructions, the dev TUI's `connection_execute` rendering, and the channel
  task card.

## Tests and rollout

- **Captured-request unit test.** It drives one session through each entry:
  - a `search`, then `execute` of an inline tool;
  - a foreground workflow tool that parks and resumes;
  - a background workflow tool;
  - a deferred subagent;
  - a connection tool that parks for sign-in;
  - a dynamic connection resolving;
  - a dynamic deferred tool and a dynamic deferred subagent appearing
    mid-session, then one of them disappearing;
  - a `search` that returns a tool and a skill with the same name, then
    `execute({ skill })` for a deferred static skill with package files;
  - a deferred dynamic skill appearing on `turn.started`, then loading;
  - `execute({ skill })` for a skill that isn't deferred;
  - an approval as the last message;
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
  - Migrate `agent-openapi-swagger` and `agent-workflow-tools` from the
    connection tools, and `agent-skills` from `load_skill`.
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
- **Docs.**
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
- **Changeset.** `minor`, because it:
  - removes `connection_search`, `connection_execute`, and `load_skill`;
  - reserves `search` and `execute` in every agent;
  - rejects names that start with a connection's prefix, which an existing
    agent may already have, such as connection `linear` beside a tool named
    `linear__sync`.

## Decisions and alternatives considered

| Decision            | Chosen                                                                                | Rejected                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool names          | `search` and `execute`                                                                | `tool_search` and `tool_execute` (no collision risk, but the names don't match the functions inside a code-mode program)                                                                                                     |
| Search surface      | One `search` over every entry, connections included                                   | Keeping `connection_search` next to it (two places to look, two listings); a separate `skill_search`                                                                                                                         |
| Variants            | A key per variant: `tool` and `skill` now, `code` later                               | One name space with markers such as `skill:pdf`; a `kind` field the model must echo                                                                                                                                          |
| Presence            | Always, in every session of every agent                                               | Only while the catalog is non-empty (flips `tools` when a dynamic entry appears); an agent-level flag                                                                                                                        |
| Dynamic entries     | Deferrable, like static ones                                                          | Static only (rules out per-tenant catalogs)                                                                                                                                                                                  |
| Opt-in              | `deferred: true` on tools and skills; `tool: "deferred"` on agents                    | An agent-level list of names; `deferLoading` (eve never loads the definition); pi's `exposure` enum                                                                                                                          |
| Discovery mechanism | Two fixed tools                                                                       | AI SDK `toolSearch()` or activation (grows `tools`); provider-native search (one provider at a time, partly beta)                                                                                                            |
| Dispatch            | Resolve to an entry, then dispatch it like a direct call                              | A `defineTool` proxy (can't reach workflow tools or subagents; duplicates approval)                                                                                                                                          |
| Entry names         | One flat name, `__` as the only namespace separator, and connections own their prefix | `<connection>.<tool>` (a second separator for one owner, and it renames connection tools); dots everywhere, encoded as `__` for providers (deferring would rename a tool); a separate `connection` argument (a two-part key) |
| Owners              | Recorded on each entry as data                                                        | Recovered by splitting names at `__` (can't tell an owner from a convention prefix)                                                                                                                                          |
| Search output       | TypeScript `signature`                                                                | Raw JSON Schema (larger, and code mode needs the signature anyway)                                                                                                                                                           |
| Protocol shape      | Actions carry the entry's name; only history says `execute`                           | An outer `execute` action with a nested entry action                                                                                                                                                                         |
| Search state        | Stateless; any entry can be executed                                                  | A durable discovered set that execution checks                                                                                                                                                                               |
| Listing             | One append-only listing: names, plus connection descriptions                          | Nothing (the model can't tell when to search); full signatures (eval-gated)                                                                                                                                                  |
| Loading skills      | `execute({ skill })` for every skill; `load_skill` is removed                         | Keeping `load_skill` beside `execute` (two ways to load); `load_skill` only for skills that aren't deferred (the model must know which kind it has)                                                                          |

## Later: code mode

Code mode adds `execute({ code })`. The rest of this design carries over:

| This design                    | Code mode                                                        |
| ------------------------------ | ---------------------------------------------------------------- |
| `search(opts)` tool            | `search(opts)` inside the program, same result shape             |
| `execute({ tool, input })`     | `tools.deploy_service(input)`, `tools.linear.list_issues(input)` |
| `execute({ skill })`           | Loading a skill from the program                                 |
| One action per `execute` call  | One nested action per call, with `parentCallId`                  |
| Approval on the model's call   | Approval on the nested action, parking mid-program               |
| Catalog listing                | Unchanged                                                        |
| Signatures in `search` results | The types the program is written against                         |

- `execute({ tool, input })` is a one-call program, so both forms share one
  dispatch path.
- Program paths come from the owners each entry records, not from splitting
  names: `linear__list_issues` is `tools.linear.list_issues`,
  `crm__api__list_issues` is `tools.crm.api.list_issues`, and
  `tenant__export`, which has no owner, is `tools.tenant__export`.
- The `code` property appears only when code mode is on. That is fixed per
  agent and eve version, never per step, so the `tools` array stays stable.
- Names with `-` aren't JavaScript identifiers. A kebab-case connection such
  as `google-drive` is called as `tools["google-drive"].list_files(input)`.
