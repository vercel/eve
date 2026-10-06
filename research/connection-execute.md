---
issue: TBD
status: superseded
last_updated: "2026-10-06"
---

# Cache-stable connection tools

Superseded by [deferred tools](./deferred-tools.md). `search` and `execute`
replace `connection_search` and `connection_execute` with one catalog that also
covers deferred tools and subagents. Connection tools keep their
`<connection>__<tool>` names, and connection calls no longer report nested
actions. The result format, sign-in, approval, instance
pinning, and cache invariants below carry over. The model surface below
records the shipped connection tools, not current guidance.

## Summary

`connection_search` breaks the prompt cache. Every hit adds
`<connection>__<tool>` definitions to the provider `tools` array, and tools
render before the system prompt and messages, so the whole cached prefix is
lost. The tool's own description also lists connection names, so a dynamic
connection resolving mid-session changes it too.

Code mode ([#3886](https://github.com/vercel/eve/pull/3886),
[#3951](https://github.com/vercel/eve/pull/3951)) fixes this, but it is too
large to land now. This doc proposes the slice of it that needs no
interpreter:

- **Two fixed tools.** `connection_search` finds tools and
  `connection_execute` calls one. Their definitions never change, and they
  exist for the whole session whenever the agent has connections.
- **Append-only connection listing.** Connection names and descriptions
  leave the system prompt and tool descriptions. They arrive as a
  `context.state` baseline, later diffs, and a fresh baseline after
  compaction, following opencode v2.
- **Code mode's result format and protocol shape.** `connection_execute`
  returns exactly what `tools.<connection>.<tool>(input)` will return in code
  mode. It reports the connection call as a nested action named
  `<connection>__<tool>` with a new `parentCallId`, as both code mode docs
  propose.

When code mode lands, it replaces the entry point. The listing, search,
result format, and nested actions carry over unchanged.

## Current state

- **Discovered tools become tool definitions.**
  `resolveConnectionSearchDynamicTools`
  (`execution/tools/connection-search.ts`) runs on every `step.started`. It
  adds one definition per hit stored under `eve.connectionSearchResults`.
- **The search tool changes.** Its description ends with
  `Available connections: …`. The tool exists only while at least one
  connection is registered, so dynamic connections can add or remove it
  mid-session.
- **Schemas are paid for twice**, once in the search result and once in the
  tool definition.
- **Every discovery costs a turn.** Hits become callable only in the next
  response.
- **Two sources list connections.** The system prompt lists static
  connections (`runtime/prompt/connections.ts`). Dynamic connections appear
  only in the search tool's description.
- **Announcements can leak into the system prompt.** When the tail message
  is an approval response, `createCurrentMessages().add()`
  (`harness/current-messages.ts`) falls back to a system message. The
  skill-list announcement uses that path.
- **Matching is word overlap** on tool names and descriptions only.

## Prior art: opencode v2

Sources: branch `v2` at
[`c0d49f1`](https://github.com/sst/opencode/tree/c0d49f101c3079f4fb3f08af4026fb5cb0873745),
read but not run.

- **Fixed description.** `core/src/codemode/tool.ts`: "Invariant
  model-facing guidance; the changing tool catalog is delivered through
  Instructions." No tool or namespace name enters a tool definition.
- **Append-only catalog.** `core/src/codemode/instructions.ts` renders a
  baseline, then diffs such as "New tools are available…" and "…no longer
  available and must not be called". It sends the full catalog again when a
  diff would be longer. Earlier messages are never rewritten.
- **Baseline per epoch.** `core/src/session/instruction-state.ts` records
  deltas as chronological session events, and compaction starts a new epoch
  from the current values.
- **Transport.** On AI SDK routes, deltas become escaped `<system-update>`
  user messages (`ai/src/protocols/shared.ts`), the same shape as eve's
  `context.state`.
- **Deterministic rendering.** Namespaces are sorted, and entries are chosen
  by cost and path (`core/src/codemode/catalog.ts`).

## Prior art: AI SDK

Read in the versions eve pins: `ai@7.0.105` and `@ai-sdk/code-mode@1.0.62`.
eve already uses `@ai-sdk/mcp` for MCP transport, discovery, and calls.

- **`toolSearch()` with `deferLoading`.** Called directly by the model, a
  search adds its matches to the active tools on the next step, which changes
  `tools` and loses the cache just as the old `connection_search` did. It
  stays cache-stable only when every deferred tool is callable solely through
  `code_mode` with `toolDiscovery: 'conversation'`. It also needs every tool
  definition before the generation starts, so each connection would have to
  connect, and sign in, first. It keeps discoveries in memory for one
  generation, while eve runs each step durably.
- **Code mode's conversation catalog.** `toolDiscovery: 'conversation'`
  delivers TypeScript signatures in user messages and keeps the `code_mode`
  description fixed, the same split this slice makes. The renderer is not
  exported, so this slice renders its own signatures. The types match; the
  differences are a single-line layout, constraints such as `pattern` kept as
  comments, and no generated example call. Code mode can use its own
  catalog once it lands.

## Design

```text
             tools array (fixed for the session)
             ┌──────────────────────────────────────────┐
             │ connection_search   connection_execute   │
             └──────────────────────────────────────────┘
messages:  [system prompt, no connection names]
           [context.state: connections baseline]
           ... turns ...
           [context.state: connections diff]     ← append only
           ... compaction ...
           [context.state: new baseline]

connection_execute({ connection, tool, input })   ← model-visible action
  └─ linear__list_issues(input)                   ← nested action, parentCallId
       result → same value code mode returns
```

### Model surface

**`connection_search`**

- **Input:** `{ query?: string, connection?: string, limit?: number, offset?: number }`.
  `limit` defaults to 10 and is capped at 50. Omitting `query` lists every
  tool, which pairs with `connection` to list one connection's tools.
- **Result:** `{ tools, total, unavailable? }`, where `tools` holds ranked
  entries of `{ connection, tool, description, signature }` and `total`
  counts matches across pages.
  - `signature` is TypeScript rendered from the input and output schemas,
    with JSDoc from the schema descriptions. It keeps constraints such as
    `minimum`, `maximum`, and `pattern` as comments.
  - An output with no schema renders as `Promise<unknown>`.
  - The raw JSON Schema is not repeated, so each schema is paid for once.
- **Connection failures.** A plain search never prompts. A connection that needs
  sign-in is returned in `unavailable` with `requiresSignIn: true`.
  `connection_search({ connection, signIn: true })` starts authorization for
  that one connection and returns its tools once the user signs in. A connection
  that fails is returned in `unavailable` with its `error`.
- **Ranking.** Prefix word matching, weighted by field: tool name, then
  connection name, input property names, tool description, and last
  property descriptions and the connection description. The ranking can
  change later with no change to the result shape.

**`connection_execute`**

- **Input:** `{ connection: string, tool: string, input: object }`.
- **Description.** Fixed per eve version. It tells the model to prefer
  connected services over web search or general knowledge, and to use names
  exactly as returned by `connection_search`.
- **Result:** see [Result format](#result-format).

**Both tools**

- **Presence.** Both are present for the whole session when the agent has a
  static connection or a dynamic connection resolver. Otherwise neither
  exists. The connection registry exists under exactly that condition, so
  the `tools` array never flips.
- **Closed.** They cannot be replaced or disabled. An authored
  `agent/tools/connection_search.ts`, `agent/tools/connection_execute.ts`,
  or `agent/tools/connection_tools.ts` (the framework module that provides
  them) is a compile error. Removing every connection is how an agent goes
  without them.
- **Built on the public tool API.** A framework `defineDynamic` module
  rebuilds both tools on each `step.started` with `defineTool` and
  `defineDurableCallback`. Their descriptions and input schemas are
  constants, so the provider request is identical every step. Rebuilding
  per step is what lets `connection_execute` carry the approval phases of
  the connections currently registered without a harness change.

### Connection listing

- **Baseline.** On a session's first model step, eve appends one
  `context.state` message listing each connection's name and description,
  sorted by name.
- **Diffs.** When the dynamic connection set changes (a connection added,
  removed, or with a changed description), eve appends a diff. It sends the
  full listing again when that is shorter.
- **After compaction.** Compaction already clears `HistoryState`
  (`harness/tool-loop.ts`), so the next step appends a fresh baseline.
- **Tracking.** `HistoryState` records the last listing it announced, as it
  already does for `availableSkills`.
- **Not in the listing:** tool names and signatures, which `connection_search`
  returns, and sign-in status. Status would add a diff on every sign-in.
  Search and execute results report it instead.
- **System prompt.** The Connections section is removed. The system prompt
  and tool descriptions name no connection.
- **No system-message fallback.** When the tail message is an approval
  response, the announcement waits for the next step instead of becoming a
  system message. This applies to the skill-list announcement too.

Example baseline, followed by a later diff:

```text
Connections. Find their tools with connection_search and call them with connection_execute.
- linear: Linear issues and projects
- petstore: Pet store inventory API
```

```text
Connections changed.
Added:
- github: GitHub repositories and pull requests
No longer available, do not call: petstore
```

### Result format

`connection_execute` returns the value code mode will return to a program:

| Source                                    | Value                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| MCP result with `structuredContent`       | `structuredContent`                                                             |
| MCP result with text content only         | The text. Parsed as JSON when the tool declares no `outputSchema` and it parses |
| MCP result with image or resource content | Its MCP `content` blocks; the model sees them as text and file parts            |
| MCP result with `isError: true`           | A tool error carrying the text                                                  |
| OpenAPI                                   | `{ status, statusText, body }`, unchanged                                       |

- **File parts.** `toModelOutput` receives only the output, so a result
  with non-text content keeps its MCP `content` blocks in the value.
  `connection_execute`'s `toModelOutput` turns image, audio, and blob
  resource blocks into file parts. The value in `action.result` stays JSON.
- **Errors are data the model can act on.**
  - An unknown connection lists the available connections.
  - An unknown tool names the closest tools.
  - Invalid input returns the tool's `signature`.

  eve validates the input against the tool's input schema before calling,
  because the provider never saw that schema.

### Execution

A `connection_execute` call does what a discovered tool call does today.
The difference is that the connection and tool come from the call's input,
not from a discovery record.

- **Approval.** The connection's `approval` policy runs on the
  `connection_execute` call.
  - The policy sees `toolName` as `<connection>__<tool>` and `toolInput` as
    the inner input, so existing policies behave the same.
  - `approvalKey` returns `<connection>__<tool>`, so an "always approve"
    decision still applies per tool.
  - `connection_execute` has approval phases only when a registered
    connection defines them. When any connection defines a response
    policy, every connection approval in that agent uses the
    authenticated response flow; connections without one allow any
    authenticated responder.
- **Authorization.** This is unchanged: interactive sign-in parks the call
  through `input.requested`. A server `401` evicts the cached token and
  starts authorization again. Completion is rejected if the connection
  instance changed while sign-in was pending.
- **Tool filters and provided arguments.** `tools: { allow | block }` and
  `toolCall.providedArguments` are already enforced by the MCP and OpenAPI
  clients. They apply to search and execution with no change.
- **Approved instance.** The approval request records the connection's
  instance id for the call in durable session context. The approved call is
  rejected, and must be requested again, if its connection resolves to a
  different instance when it runs. This replaces the harness-level replay
  identity that discovered tools needed.

### Nested actions on the protocol

Code mode reports each call a program makes as a nested action. This slice
uses the same shape now.

- **Model-visible action.** The model's call is a `tool-call` action named
  `connection_execute`, and model history holds only that call and its
  result.
- **Nested action.** For the connection call, eve also emits
  `actions.requested` and `action.result`. The action has:
  - `toolName: "<connection>__<tool>"`,
  - the inner input,
  - its own call id, derived from the parent's, so a re-run step emits the
    same id,
  - a new optional `parentCallId` set to the `connection_execute` call id.

  eve emits the pair when the connection call settles, right before the
  `connection_execute` result. A call that parks for sign-in reports no
  nested action until it runs.

- **Generic.** A tool reports a nested action through an internal harness
  API that stashes it for the current step; the harness drains it before
  the parent's `action.result`. Code mode reuses the same path.
- **Unchanged consumers.** Labels, hooks, channel audience policy, tracing,
  and eval assertions such as `t.calledTool("linear__list_issues")` see the
  nested action as they see a direct call today.
- **Rendering.** The dev TUI shows a `connection_execute` call as
  `Call <connection>.<tool>` and hides its nested action. Other channels and
  clients that ignore `parentCallId` render both.
- **Protocol change.** `parentCallId` is an additive public change. It ships
  with protocol docs.
- **Approval prompts** are the one difference from code mode. The approval
  request belongs to the model-visible `connection_execute` call, because
  the AI SDK ties approval to the model's tool call. Its presentation uses
  the qualified name and inner input. Code mode moves approval to the
  nested action when a program can park mid-run. Each `connection_execute`
  call makes exactly one nested call, so the model sees no difference.

## Cache invariants

1. **Fixed tools.** The `tools` array is identical for every step of a
   session.
2. **No session-specific text in the system prompt or tool descriptions.**
3. **Append-only history.** Listing changes only append; earlier messages
   are never rewritten.
4. **No system-message fallback** for any announcement.
5. **Deterministic rendering.** Listings and signatures are sorted and
   memoized per connection instance.

Tests:

- **A unit test over the captured model request.** It drives one session
  through search, execute, a sign-in park and resume, a dynamic connection
  resolving, an approval at the tail, and compaction. It asserts all five
  invariants.
- **A real-model e2e eval.** It asserts cache reads on the steps after
  discovery, following `e2e/fixtures/agent-prompt-cache`. It runs against a
  self-contained OpenAPI connection such as the petstore fixture.

## Removed

- The materialized `<connection>__<tool>` tool definitions and the
  `eve.connectionSearchResults` session key.
- The `connectionSearch` `defineDynamic` export (`eve/tools/connection-search`)
  and replacement of `connection_search` from `agent/tools/`.
- The system prompt's Connections section.

## Rollout

- **Baseline.** Measure on `main`, for discovery-heavy sessions:
  - cache read ratio per step,
  - input tokens and cost per task,
  - model calls,
  - task success.

  [#3926](https://github.com/vercel/eve/pull/3926)'s discovery benchmark
  already has a dispatch arm, "`discover` and `tool_call`", which is this
  design, so its cases can be reused.

- **First PR.**
  - The announcement deferral fix.
  - `HistoryState` support for more than one announcement.
  - The request-capture unit test.

  None of this changes what the model sees.

- **Second PR.** Everything else:
  - the two tools,
  - the connection listing,
  - the result format,
  - nested actions with `parentCallId`,
  - migrated e2e fixtures (`agent-openapi-swagger`, `agent-workflow-tools`),
  - docs (`connections/overview`, `connections/mcp`,
    `concepts/built-in-tools`, `guides/dynamic-capabilities`, and the
    mention in `tools/workflows`),
  - a `minor` changeset, since it removes a public export and changes model
    tools.
- **New evals.**
  - Cache reuse across discovery.
  - A dynamic connection resolving mid-session with the tools unchanged.
  - Approval on `connection_execute` keyed per connection tool.
  - An unknown tool name recovered from the suggestion.
  - An MCP tool returning an image.
- **Ship gate.** Against the baseline:
  - a clearly higher cache read ratio after discovery,
  - no task-success regression on connection evals,
  - no new nondeterminism in world-suite e2e runs.
- **Later, gated by evals.** Inline signatures in the baseline up to a token
  budget, as opencode v2 does. This means listing tools at session start,
  which connects to every server and may prompt for sign-in early.

## Path to code mode

| This slice                                        | Code mode                              |
| ------------------------------------------------- | -------------------------------------- |
| `connection_search`                               | `search()` inside the program          |
| `connection_execute({ connection, tool, input })` | `tools.<connection>.<tool>(input)`     |
| Connection listing (baseline and diffs)           | Catalog baseline and diffs             |
| Result format                                     | Unchanged                              |
| Nested action with `parentCallId`                 | Unchanged; one per call in the program |
| Approval on the model-visible call                | Approval on the nested action          |

Code mode then removes the extra turn between searching and calling, and
lets a program compose several calls.

## Decisions and alternatives considered

| Decision          | Chosen                                                                    | Rejected                                                                     |
| ----------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Scope             | Two fixed tools now; code mode later                                      | Waiting for code mode; the AI SDK's `toolSearch()`, which also grows `tools` |
| Call tool name    | `connection_execute`                                                      | `connection_call`, `tool_call`                                               |
| Protocol shape    | Nested `<connection>__<tool>` action with `parentCallId`, as in code mode | Reporting only `connection_execute`; renaming the model-visible action       |
| Result format     | Code mode's value; file parts kept in model output                        | The raw MCP envelope; dropping non-text blocks                               |
| Presence          | Fixed at build time; absent without connections                           | Present only while a connection is registered (flips `tools`)                |
| Replacement       | Closed tools; remove connections to go without                            | Overridable `agent/tools/connection_search.ts`                               |
| Connection names  | Append-only `context.state` listing                                       | System prompt (misses dynamic connections); tool descriptions                |
| Inline signatures | Deferred behind evals                                                     | In this slice (needs eager connect and early sign-in)                        |

## Evidence limits

- **Cache hit rates are unmeasured.** The baseline and ship gate measure
  them.
- **Prior art comes from reading source.** opencode v2 was read at
  `c0d49f1`, not run.
- **The extra turn remains.** In #3951's benchmarks, searching in one model
  turn and calling in the next added 127% wall time on one task. Models
  guessed names before searching in 11 of 20 attempts. This slice makes
  those costs cheaper (no lost cache, suggestions on a wrong name) but does
  not remove them.
