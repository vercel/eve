---
issue: TBD
status: proposed
last_updated: "2026-09-27"
---

# Native code mode

## Summary

eve replaces `connection_search` and the `workflow()` tool with one code
tool, `execute`. The model writes a short JavaScript program. The program
can call any of the agent's tools, call connection tools, and spawn
subagents, all through a typed `tools` object, and it composes the results.
Connection tools never enter the provider `tools` array. Connecting,
authorizing, or discovering them never breaks the prompt cache. Today, every
successful `connection_search` breaks the whole cached prefix.

- **Scope.** This ships as default behavior, with no flag and no per-tool
  opt-in. Direct tools stay direct, and scripts can also call them.
- **Raw JavaScript.** On providers with grammar-constrained tools, the model
  writes the program as raw JavaScript instead of a JSON-escaped string.
  Elsewhere it sends `{ code }`.
- **Subagents.** `workflow()` merges into `execute`. Everything it covers
  moves to `tools.agents.<name>(...)`, and `workflow()` is removed in the
  same release, so models never see two JavaScript tools.
- **Catalog.** The catalog arrives as append-only conversation messages, and
  the `execute` description never changes.
- **Nested calls** go through the existing harness tool path: approvals,
  connection authorization, tracing, and protocol events. A call that must
  wait for a person, a sign-in, or a subagent parks the program durably. The
  program then resumes from a replay ledger.
- **Output schemas.** A tool without an `outputSchema` is still callable and
  typed `unknown`. `eve build` warns about authored tools that lack one, and
  a future version may require it.
- **Ship gate.** Measured cache reuse, model calls, and task success gate
  the release against today's baseline.

This is also the substrate for skill sets. Activating one appends a catalog
namespace instead of rewriting the `tools` array.

## Why now

- **One agent that activates capabilities.** V showed that routing work to
  specialist subagents fails in ways that are hard to undo. The direction is
  one agent that pulls in specialist capability when it needs it. That is only
  affordable if activation does not bust the cache, and mutating the `tools`
  array always does.
- **The AI SDK shipped code mode.** `@ai-sdk/code-mode` provides a QuickJS
  runtime with interrupts, approvals, and signed continuations. eve already
  vendors 1.0.62 and uses it in the `workflow` tool.
- **Output types are available.** Composition needs known output types.
  Almost every eve framework tool, MCP output schemas, OpenAPI response
  schemas, and authored schemas provide them.

## Current state

**Any tool change invalidates the full cache.** `prepareModelTools`
(`harness/tool-loop.ts`) rebuilds the `ToolSet` every step. Providers
render tools before the system prompt and messages, so any change to the
`tools` array invalidates the entire cached prefix. eve places Anthropic
breakpoints on the last tool, the system prompt, and the conversation tail
(`harness/prompt-cache.ts`). None of them survive a tool change.

**`connection_search` busts the cache on every hit.**
(`execution/tools/connection-search.ts`)

- Each discovered tool is added to the `tools` array on the next step as
  `<connection>__<tool>`, which invalidates the cached prefix.
- Each schema is paid for twice: once in the search result, once in the tool
  definition.
- The tool exists only while connections are registered. A dynamic
  connection that appears or disappears mid-session also changes the
  `tools` array.
- Matching is naive token overlap.
- A tool cannot be discovered and called in the same step.

**The append-only channel leaks.** Dynamic skill changes are appended as
framework `context.state` user messages (`harness/current-messages.ts`). When
the tail message is an approval response, the text falls back to a system
message, which breaks the cache.

**Pieces to build on**

- **Durable code mode.** The `workflow` tool already runs model-written
  JavaScript in QuickJS as a pure step. Each `ctx.agent()` call becomes an
  interrupt, and the program resumes from a signed continuation. The signing
  key is created in a durable step (`execution/dynamic-workflow/`).
- **Framework output schemas.** Every framework tool except `web_search`
  declares an `outputSchema`.
- **MCP output schemas.** MCP connections forward the server's
  `outputSchema` when one exists.
- **Untyped OpenAPI results.** OpenAPI connections declare no output schema.
  They return `{ status, statusText, body }` untyped, even when the spec
  describes the response.
- **Grammar-constrained tools.** eve's pinned `@ai-sdk/openai` 4.0.69 exposes
  `openai.tools.customTool` with a Lark or regex `format`. The model returns
  a raw string that matches the grammar.

## Prior art

Sources:

- opencode v2: branch `v2` at
  [`c0d49f1`](https://github.com/sst/opencode/tree/c0d49f101c3079f4fb3f08af4026fb5cb0873745).
  The `dev` branch is v1.
- pi: open PR [earendil-works/pi#10040](https://github.com/earendil-works/pi/pull/10040)
  ("Codemode and MCP") at `fd7798b`. Its author notes it "should not be
  merged yet" in this form.
- `@ai-sdk/code-mode`: `vercel/ai` at `5d12eaa`, 1.0.75. It has the same API
  as eve's 1.0.62. See the [docs](https://ai-sdk.dev/docs/ai-sdk-core/code-mode).

|                   | opencode v2                                        | pi PR #10040                                               | AI SDK code mode                                    | eve (proposed)                                  |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| Tool input        | JSON `{ code }`                                    | raw JavaScript via Lark grammar where supported            | JSON `{ js }`                                       | raw JavaScript via Lark grammar where supported |
| Default           | always on                                          | off; enabled when code-mode MCP servers connect            | opt-in                                              | always on                                       |
| Callable in code  | MCP tools and 5 admin tools; built-ins direct only | every tool by default, including built-ins                 | tools routed to code mode                           | every tool, connections, subagents              |
| Catalog placement | session baseline plus appended deltas              | codemode tool description                                  | tool description (default) or appended full catalog | appended baseline plus deltas                   |
| Discovery         | budgeted listing plus `search()`                   | budgeted listing plus `searchTools()` and `describeTool()` | full declarations                                   | budgeted listing plus `search()`                |
| Unknown outputs   | `Promise<unknown>`                                 | typed MCP `CallToolResult` envelope                        | `Promise<unknown>`                                  | `Promise<unknown>`                              |
| Pausing           | none                                               | none; OAuth throws "Run /mcp to sign in"                   | signed interrupts (undocumented)                    | durable parking and ledger replay               |
| Subagents in code | no                                                 | no                                                         | no                                                  | `tools.agents.*`                                |
| Nested visibility | progress on the parent call                        | metadata on the parent result                              | none                                                | protocol actions with `parentCallId`            |

**opencode v2**

- **Tool split.** Every built-in tool is direct and not callable from code
  (`codemode: false`, `core/src/tool/plugin/`). Code mode holds all MCP
  tools plus five opencode-owned tools.
- **Invariant description.** The `execute` description contains runtime rules
  only.
- **Catalog.** `codemode/catalog.ts` lists every namespace with its tool
  count, then inlines signatures round-robin up to about 2,000 tokens. The
  model reaches the rest through a synchronous `search()`.
- **Catalog updates.** Changes append as deltas (`session/instruction-state.ts`),
  and the baseline resets only at compaction. On AI SDK provider routes,
  deltas become escaped `<system-update>` user messages
  (`ai/src/protocols/shared.ts`), the same shape as eve's `context.state`.
- **MCP results.** A program receives `structuredContent` when present,
  otherwise text. JSON-looking text is parsed when the tool declares no
  output schema.
- **What not to copy.** opencode sets no limits, and adds a `fetch` global
  with no permission check or SSRF guard.

**pi PR #10040**

- **Every tool is callable from scripts.** A `ToolExposure` of `direct`
  (the default) declares a tool to the model _and_ makes it callable from
  scripts (`coding-agent/src/core/extensions/types.ts`). Built-ins such as
  read, write, edit, and bash stay direct and are composable in code. bash
  gains an `outputSchema`.
- **Raw JavaScript input.** On providers that support it, `codemode` is
  declared with a Lark grammar, so the model writes raw source instead of a
  JSON-escaped string (`codemode/src/source.ts`, `openai_lark`).
- **Nested calls** run the same steps as model-issued calls, including
  extension hooks, with a parent call id.
- **What not to copy.**
  - The catalog lives in the `codemode` tool description, so an MCP server
    connecting changes the declaration. Its docs note this "can invalidate
    the cached prefix".
  - There is no way to pause a script: a nested call that needs sign-in
    fails.

**AI SDK**

- **Replay ledger.** On resume, `run` reads completed host calls from the
  ledger instead of re-invoking them. It keeps guest `Date.now()` and
  `Math.random()` deterministic, and rejects divergent replays. Calls first
  reached after the recorded frontier run normally, which allows "run inline,
  interrupt only to park."
- **Host-owned rendering.** `experimental_runCodeMode` lets the host own the
  description and catalog rendering.
- **Default cache behavior.** The default discovery mode, `"description"`,
  embeds the catalog in the tool description and breaks the cache on any
  change. Local `toolSearch()` adds discovered tools to the `tools` array
  (`ai/src/tool-search/prepare-tool-search.ts`), which breaks the cache the
  same way `connection_search` does.

**Others**

- [Cloudflare Code Mode](https://developers.cloudflare.com/agents/tools/codemode/)
  runs programs in Worker isolates and adds in-program `search()` and
  `describe()`.
- Anthropic's
  [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
  and
  [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
  are provider-native equivalents. They are possible future backends, but
  they don't work across providers.

## Principles

1. **Every tool is callable from code.** Direct tools keep their direct form,
   so models keep the behavior they are trained on, and scripts can compose
   them with everything else. Connections and subagent calls that return the
   child's output exist only in code, so the `tools` array never grows with them. This follows
   pi.
2. **Catalog placement protects the cache, not code mode itself.** Three
   things must hold: a description that never changes, a catalog that only
   appends, and a new baseline only at compaction. The AI SDK default and pi
   both break the first by putting the catalog in the tool description.
3. **Unknown outputs limit composition, not calls.** A program that returns
   `await tools.x.y(input)` is equivalent to a direct call and keeps the cache
   intact. Rejecting tools without schemas would forfeit the cache win for
   most MCP servers.
4. **Search belongs inside the program.** Discovering and calling a tool in
   one `execute` call changes nothing in the `tools` array.
5. **Durability reuses what exists.** `run`'s replay ledger maps onto eve's
   parking model (approval, OAuth, and durable waits), and the `workflow`
   tool already exercises it.

## Design

### Model surface

**`execute`**

- **Input.** The input is one JavaScript program, `code`.
  - On OpenAI Responses models, eve declares `execute` as an OpenAI custom
    tool with a Lark grammar that accepts any non-empty source, so the model
    writes raw JavaScript.
  - Other providers receive a JSON tool with `{ code: string }`.
  - Either way, eve normalizes the call to `{ code }` in history, protocol
    events, and evals.
  - The declaration is fixed per provider, so it never changes mid-session.
- **Fixed description.** The description is fixed per eve version. It states
  the runtime rules, tells the model to prefer connected services over web
  search or general knowledge, and never names a tool or connection.
- **Presence.** `execute` is present in every agent. Every agent has tools
  scripts can call, so it never appears or disappears mid-session.
- **Closed and required.** `execute` replaces `connection_search` in the
  required framework slot. It cannot be disabled or overridden.
  - An authored `agent/tools/execute.ts` is a compile error.
  - So is `agent/tools/connection_search.ts`, whose error names `execute` as
    the replacement.
  - `workflow()` and the `eve/tools/workflow` export are removed. An agent
    that still imports it gets a compile error naming `tools.agents.*` in
    `execute` as the replacement.
- **Naming in docs.** Docs call it "the code mode `execute` tool" to
  distinguish it from a tool definition's `execute` function.

**Program globals**

- `tools.<namespace>.<name>(input)` and `tools.<name>(input)`
- An async `search({ query?, namespace?, limit?, offset? })` over the
  catalog, called as `await search(...)`. See [Search](#search).
- `console`
- No `fetch`, filesystem, timers, or imports. HTTP and files go through tools
  that enforce eve's authorization, SSRF, and sandbox policies.

**Result**

- The model receives the JSON return value, captured logs, and a summary of
  nested calls.
- Errors are returned as data with suggestions, such as "Did you mean
  `tools.linear.list_issues`?", or the available namespaces when a
  connection name is wrong.

**What scripts can call**

Every tool the agent has, with two exceptions:

- `execute` itself, since programs don't start programs;
- the final output tool, which ends the turn and belongs to the model.

**How that relates to direct calls**

- **Direct tools** remain in the `tools` array, unchanged, and are also
  callable from scripts: `bash`, `read_file`, `write_file`, `glob`, `grep`,
  `web_fetch`, `web_search`, `load_skill`, `ask_question`, `task_cancel`, and
  authored and extension tools.
- **Connection tools** are reachable only from scripts.
- **Subagents** keep their direct tool, which starts a background task and
  returns a receipt. In scripts they appear only as
  `tools.agents.<name>(...)`, which resolves to the child's output. The
  `execute` call parks durably while the child runs, so no compute is held.
- **Nested calls that need a person.** A nested `ask_question` parks the
  program until the person answers, the same way a nested approval does.

**Skills** keep their listing, and `load_skill` stays a direct tool.
Skill-list updates follow the same append-only rule as the catalog.
`load_skill`'s hint for connection names points to `search({ namespace })`
inside `execute`.

### Catalog

**Namespaces** derive from file paths, and collisions are compile errors.

| Source                       | Path                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| Framework and authored tools | `tools.<tool>`, for example `tools.read_file`               |
| Extension tools              | `tools.<extension>.<tool>`                                  |
| Connection tools             | `tools.<connection>.<tool>`                                 |
| Subagents                    | `tools.agents.<name>({ message, agentId?, outputSchema? })` |

`agents` is a reserved namespace. A connection, extension, or tool named
`agents` is a compile error. Dynamic tools and dynamic subagents join the
catalog through deltas.

**Subagents in `execute`** cover everything `workflow()` does today:

- **Returns output.** A call resolves directly to the child's
  JSON-serializable output, with no metadata wrapper. When `outputSchema` is
  given, the output is validated against it.
- **Continues a child.** Passing an `agentId` from the conversation's
  `<agents>` block continues that child. Omitting it starts a new child
  session.
- **Same checks.** The owning agent resolves the target and applies its
  existing availability and authorization checks. That covers local,
  remote, and dynamic subagents.
- **Durable.** Every agent call interrupts. The program parks until the
  child settles, then resumes from the ledger. Calls started together with
  `Promise.all` run concurrently.
- **Cap.** Each `execute` call can make at most 100 agent calls, the current
  `workflow()` default. Over the cap, the call fails with the existing
  `WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED` error, renamed for `execute`.
  The cap is fixed because code mode has no settings.
- **Failures are catchable.** A child failure reaches the program as a
  thrown error the program can catch.

**Signatures** are TypeScript rendered from JSON Schema, with JSDoc from the
schema descriptions. Outputs without a schema render as `Promise<unknown>`.
The instructions tell the model to narrow at runtime, or to return the raw
value and transform it in a later call.

**Budget**

- Every namespace is listed with its description and tool count.
- Direct tools are pinned, so their output types are always shown.
- Other signatures are inlined up to a fixed token budget, round-robin
  across namespaces.
- `search()` reaches the rest.
- Choosing which tools to show inline is deterministic, so the listing is
  byte-stable for the same inputs. Only `search()` may use a model.

**Placement**

- The baseline catalog is appended as a `context.state` message on the first
  step of a session.
- Later changes append a diff of added or removed tools and changed
  signatures. They are triggered by:
  - dynamic tools, connections, or subagents resolving,
  - OAuth completing,
  - MCP `tools/list_changed`,
  - skill sets activating.
- Compaction writes a fresh baseline.
- The last announced catalog is tracked in `HistoryState`, as the skill list
  already is.
- Catalog text never enters the system prompt or a tool description. The
  system prompt's Connections section is removed, because namespace entries
  carry connection descriptions.
- When the tail message is an approval response, the delta is deferred
  instead of falling back to a system message. This also fixes the leak in
  the skill-list channel.

### Search

`search()` returns ranked catalog entries (path, description, and
signature), with a cursor for the next page. The contract is independent of
how results are ranked.

- **Async host call.** `search()` is an ordinary async host call, not a
  synchronous binding. Programs can run searches concurrently with
  `Promise.all`.
- **Pausing.** A search can pause the program. For example, searching a
  namespace that needs sign-in starts authorization. `run`'s synchronous
  host functions cannot interrupt a run, and they hold the worker while
  they settle.
- **Call limit.** Searches count toward the per-program call limit.
- **Default implementation.** Word matching over tool paths, descriptions,
  and input property names, as in opencode.
- **Future extension.** The implementation can be swapped for a
  model-backed one with no model-facing change. For example, an evaluation
  model such as Jev could rerank a capped set of word-match candidates,
  following the `auto({ model })` pattern used for approvals.
  - Results are recorded in the replay ledger, so a nondeterministic ranker
    still replays identically after a pause.
  - Results only appear in `execute` results, so any implementation is
    cache-safe.
  - How authors configure it belongs to that future design.

### Connections in `execute`

`execute` takes over every responsibility `connection_search` has today:

- **Configuration applies unchanged.**
  - `tools: { allow | block }` filters both the catalog and calls.
  - `toolCall.providedArguments` stay out of signatures and are injected at
    execution.
  - A connection's `approval` policy gates each nested call.
- **Authorization**
  - A connection that needs sign-in before listing tools appears as a
    namespace marked "sign-in required".
  - A `search()` or call against it starts interactive authorization, which
    parks the program until sign-in completes.
  - A failed authorization marks the namespace unavailable with the error.
  - The existing check still rejects completion if the connection instance
    changed while sign-in was pending.
  - A server `401` still evicts the cached token and re-runs authorization.
- **MCP results.** Programs receive `structuredContent` when present,
  otherwise text. JSON-looking text is parsed when the tool declares no
  output schema, matching opencode.
- **OpenAPI results.** Programs receive `{ status, statusText, body }`, with
  `body` typed from the operation's success response schema.
- **State.** No per-session discovery state remains. The
  `eve.connectionSearchResults` key and the per-tool `<connection>__<tool>`
  dynamic tools are removed. The catalog is derived from the connection
  registry every step.

### Execution and durability

```text
model ── execute(code) ──▶ program step (QuickJS, pure)
                              │ nested call
                              ▼
                   harness tool path (validation, approval policy,
                   connection auth, tracing, protocol events)
                      │ runs now             │ must wait (approval, OAuth,
                      ▼                      ▼  question, subagent, durable wait)
               result to program      interrupt ─▶ execute call parks
                                                ─▶ resume: ledger replay,
                                                   completed calls not re-run
```

**Runtime**

- Programs run on `experimental_runCodeMode` in the app runtime, not the
  sandbox, so credentials stay app-side.
- Sandbox tools such as `bash` reach the sandbox through their normal
  executors.
- eve owns the description and catalog rendering.

**Nested calls** take the same path as model-issued calls:

- input validation,
- approval policies,
- connection authorization,
- tracing,
- labels.

Programs receive raw JSON. `toModelOutput` applies only to what reaches the
model.

**Parking**

- Calls run inline unless they must wait for a person, a sign-in, a
  subagent, or a durable wait.
- A call that must wait interrupts, and the `execute` call parks the same way
  a tool approval does.
- On resume, the ledger skips every completed call.

**Crash semantics** match today's inline tools. A crashed step re-runs its
whole program, and the ledger protects only across interrupts. The
idempotency guidance for `defineTool` applies unchanged.

**Limits.** The AI SDK defaults become eve's defaults. Continuation signing
reuses the durable key step `workflow()` uses today
(`execution/dynamic-workflow/security-step.ts`).

### Nested calls on the protocol

- **Standard events.** Each nested call emits the standard
  `actions.requested` and `action.result` events, plus a new optional
  `parentCallId` that points to its `execute` call.
- **Qualified names.** `toolName` keeps eve's existing qualified names, such
  as `linear__list_issues` or `read_file`. These work unchanged:
  - labels,
  - approval and sign-in prompts,
  - channel rendering,
  - eval `t.calledTool(...)`.
- **Grouping.** Clients may group actions by `parentCallId`. Clients that
  ignore the field render them flat.
- **Model history.** Nested calls never enter model history. The model sees
  only the `execute` call and its result.
- **Replay.** Replay after an interrupt does not re-emit events for
  completed calls. A crashed step re-emits events under new ids, as it does
  today.

`parentCallId` is an additive public protocol change. It ships with
protocol docs and a changeset.

### Output schemas

There is no opt-in and no code mode setting. What authors control is output
types:

```ts
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: orderSchema, // gives scripts a typed result
  execute: async ({ id }) => getOrder(id),
});
```

- **Without a schema.** A tool without an `outputSchema` is callable from
  scripts and typed `Promise<unknown>`.
- **Build warning.** `eve build` and `eve dev` warn for each tool in the
  agent's own directory that lacks one, and name the tool file. A future
  version may require output schemas.
- **eve's own tools.** `web_search` gains an `outputSchema`, so every tool
  eve owns declares one.
- **Validation.** When a tool declares a schema, its output is validated
  before a script sees it. A mismatch reaches the program as
  `InvalidToolOutput`, so the catalog never advertises a shape the tool
  doesn't return. Direct calls are unchanged.
- **OpenAPI connections** derive `outputSchema` from each operation's
  success response schema, so `body` becomes typed.

### Cache invariants

Each invariant is a test target:

1. **Stable tools.** The tools array and every tool description are
   byte-identical across steps when:
   - connections are discovered, authorized, or resolved dynamically,
   - the catalog changes,
   - dynamic skills change,
   - skill sets activate.
2. **Clean system prompt.** The system prompt contains no catalog text that
   varies by session.
3. **Append-only history.** Catalog and skill-list changes only append;
   earlier messages are never rewritten.
4. **No fallback.** No announcement falls back to a system message.
5. **Deterministic rendering.** Catalog rendering is sorted and memoized per
   revision.

Two tests cover them:

- A unit test over the rendered request prefix covers all five.
- A real-model e2e eval asserts cache reuse across discovery, following
  `e2e/fixtures/agent-prompt-cache`.

## Skill sets

Activating a skill set appends two deltas:

- its tools, as `tools.<skillSet>.*`, executed remotely over MCP-style RPC;
- its skills, as unloaded skill-list entries.

The `tools` array does not change, so activation is cache-safe, and a removal
delta reverses it. Hooks, presentation, and identity forwarding belong to the
skill sets design.

## Rollout

This ships all at once, and there is no flag. Validation happens before
merge.

**Baseline.** Measure the current `connection_search` and `workflow()`
paths on `main`:

- cache read ratio per step,
- input tokens and cost per task,
- model calls per task,
- latency,
- task success.

**Build and migrate.** One release carries everything:

- `execute`, with the grammar and JSON forms, the catalog, and `search()`,
- nested approvals, questions, and authorization,
- `parentCallId`,
- OpenAPI output schemas,
- the `web_search` output schema,
- output-schema build warnings,
- `tools.agents.*`.

It also removes `connection_search` and `workflow()`. Their docs move to
`execute`:

- `connections/overview`,
- `connections/mcp`,
- `concepts/built-in-tools`,
- `guides/dynamic-capabilities`,
- `tools/workflows`.

Their e2e fixtures move too:

- `agent-workflow-tools` and `agent-openapi-swagger` for connections,
- `agent-subagents` and `agent-cancellation` for `workflow()`.

The `agent-subagents` limit test currently uses `maxSubagents: 3`. It moves
to the fixed cap of 100.

**New evals**

- a multi-connection correlation task (Alice reconciles orders against
  payments and support tickets),
- a script that combines file tools with connection data (Bob reads an
  export with `read_file` and checks each row against a connection),
- discovery across 100+ tools,
- OAuth mid-program,
- approval mid-program,
- an MCP server with untyped outputs,
- a dynamic connection resolving mid-session,
- a program that fans out to parallel subagents and combines their outputs
  with connection data,
- cancelling a turn while subagents run inside `execute`,
- the same composition tasks on an OpenAI model (grammar input) and a
  non-OpenAI model (JSON input).

**Ship gate.** Compared with the baseline, the branch must show:

- no task-success regression on connection, subagent, or sandbox evals,
- a clearly higher cache read ratio on discovery-heavy sessions,
- fewer model calls on composition tasks,
- no new nondeterminism in world-suite e2e runs.

If it misses the gate, it does not merge.

**Follow-up.** After ship, A/B test `Promise<Opaque>` ("return it whole or
pass it on; never read its fields") against `Promise<unknown>`. `Opaque`
becomes the default only if it reduces invented field accesses without
adding round trips or lowering task success.

## Decisions and alternatives considered

| Decision                       | Chosen                                                                                                 | Rejected                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Rollout                        | Ship as default, replacing `connection_search`; gated by evals                                         | An `experimental.codeMode` flag (root-only or per agent)                                         |
| Tool name                      | `execute`, matching opencode v2                                                                        | `code_mode`, `code`, `run_code`                                                                  |
| Input                          | Raw JavaScript via Lark grammar where supported, otherwise `{ code }`, as in pi                        | JSON `{ js }` everywhere                                                                         |
| What scripts can call          | Every tool except `execute` and final output; direct tools stay direct too, as in pi                   | Per-tool `codeMode: true` opt-in; direct-only built-ins (opencode v2); code-only framework tools |
| `workflow()`                   | Merged into `execute` as `tools.agents.*`; removed in the same release                                 | Keeping it as a separate direct tool; a transition period with both                              |
| Agent-call cap                 | Fixed at 100 per `execute` call, the current `workflow()` default                                      | A configurable `maxSubagents` (code mode has no settings)                                        |
| `execute` presence             | Always present                                                                                         | Present only while connections are registered (flips the `tools` array)                          |
| Outputs without schemas        | Callable and typed `Promise<unknown>`; `eve build` warns; `Opaque` tested after ship                   | Requiring schemas now; rejecting tools without them; `Opaque` from day one                       |
| Authored tools without schemas | Warning now; a future version may require `outputSchema`                                               | Build-time TypeScript extraction (needs a type checker and adds nothing at runtime)              |
| Skills in `search()`           | Tools only; skills move in with a future deferred-skills design                                        | Skill hits in `search()`; `tools.skills.load()`                                                  |
| `search()`                     | Async host call; word matching by default; replaceable later (for example, evaluation-model reranking) | Synchronous binding (cannot pause for sign-in, holds the worker, blocks model-backed search)     |
| Nested call visibility         | Protocol actions with `parentCallId`                                                                   | Progress only (breaks `t.calledTool` and approval correlation)                                   |
| Catalog placement              | Appended messages, as in opencode v2                                                                   | Tool description (pi, AI SDK default), which changes when servers connect                        |
| System prompt Connections list | Removed; namespace entries carry descriptions                                                          | Keeping it alongside the catalog                                                                 |

## Evidence limits

- **Cache hit rates are unmeasured.** No cache hit rates have been measured
  for any approach. The baseline and ship gate measure them.
- **Prior art comes from source reading.** The opencode v2, pi, and AI SDK
  behavior is from reading source at the cited commits. None of their code
  was executed. The pi PR is unmerged and may change.
- **Grammar support.** Only OpenAI Responses models are confirmed to support
  grammar-constrained tools through eve's AI SDK version. It is unverified
  whether AI Gateway routes pass OpenAI custom tools through. Other
  providers, and any route that can't, use the JSON form.
