---
issue: TBD
status: proposed
last_updated: "2026-10-10"
---

# Native code mode

## Summary

[Deferred tools and skills](./deferred-tools.md) (#4400) gave every agent one
catalog of tools, agents, connection tools, and skills, reached through fixed
tools that never change the `tools` array. That work reserved one more name
for code mode. This doc fills it in.

```ts
eve__execute(opts: { code: string }): Promise<{
  result?: unknown; // the program's JSON return value
  error?: string; // why the program failed, when it did
  logs?: string[]; // console output
  calls: Array<{ tool: string; status: "completed" | "failed" | "denied" | "cancelled" }>;
}>;
```

The model writes a JavaScript program. The program calls catalog entries and
direct tools by name, composes their results, and returns one value. Only that
value and a short call summary go back to the model, so intermediate data
never enters the conversation.

```js
const issues = await tools.linear__list_issues({ teamId: "ENG", first: 50 });
const stale = issues.nodes.filter((issue) => issue.state.type === "started");
const reviews = await Promise.all(
  stale.map((issue) =>
    tools.billing_specialist({ message: `Check whether ${issue.identifier} blocks a refund.` }),
  ),
);
return stale.map((issue, i) => ({ id: issue.identifier, review: reviews[i] }));
```

- **Opt-in per agent.** `defineAgent({ codeMode: true })` adds `eve__execute`.
  The setting is fixed for each deployment, so the `tools` array never changes
  within a session. Everything else in the catalog design stays as it is:
  `eve__search`, `eve__tool`, and `eve__skill` keep their behavior.
- **A program is a batch of `eve__tool` calls.** Each `tools.<name>(input)`
  call resolves through the step catalog and runs on the same dispatch path
  as a model-issued call. That covers input validation, approval, connection
  sign-in, workflow runs, child sessions, stubs, hooks, labels, and eval facts.
  `eve__tool({ name, input })` is a one-call program.
- **One name everywhere.** Programs call entries by their flat catalog names,
  such as `tools.linear__list_issues` and `tools.crm__api__list_issues`. These
  are the names used in `eve__search`, `eve__tool`, protocol actions,
  approvals, and evals. There is no second, nested naming scheme.
- **Inline first, park only to wait.** Calls run inline inside the program.
  The program interrupts only for a call that must wait: an approval, a
  sign-in, a workflow tool, an agent, or a question. The `eve__execute` call
  then parks durably and holds no compute. It resumes from a signed replay
  ledger, so completed calls never run again.
- **Agents are awaited, not tasked.** Inside a program, an agent call resolves
  to the agent's reply. The execute call owns the child sessions, so they
  never appear in the model's task table.
- **`workflow()` is removed.** `eve__execute` does everything the `workflow`
  program tool does and more, so `eve/tools/workflow` goes away in the same
  release.
- **Cache stable.** The `eve__execute` definition never changes within a
  deployment and names no tool. A program never adds a definition. The only
  listing change is one fixed sentence in the existing `catalog`
  announcement.

## Why now

- **The catalog exists.** #4400 shipped a step catalog that resolves any name
  to its entry and dispatches it like a direct call (`execution/catalog/`,
  `harness/execute-call.ts`). Code mode needs nothing else for discovery or
  routing. All it adds is a runtime that issues many calls per model call.
- **Composition is where round trips go.** Reconciling, filtering, fanning
  out, and joining across tools all cost one model step per call today, and
  every intermediate result stays in history for the rest of the session.
  Programs remove both costs.
- **Prior art converged.** pi and opencode v2 both shipped code mode in the
  last month, with signatures rendered from schemas and budgeted catalogs.
  Neither can pause a program mid-flight. Durable pause and resume is what eve
  adds.
- **The runtime is vendored.** eve already runs model-written JavaScript in
  QuickJS through `@ai-sdk/code-mode` 1.0.85 for the `workflow` tool, with
  signed continuations whose key comes from a durable step.

## Current state

What #4400 left on `main`:

- **Step catalog.** `buildStepCatalog` (`execution/catalog/step-catalog.ts`)
  builds one table per step from authored, dynamic, and subagent entries,
  split into `advertised` and `deferred` maps. Connection tools resolve by
  prefix ownership (`connectionEntryNamed`). The catalog's `resolve` turns an
  `eve__tool` or `eve__skill` call into the call to its entry.
- **Which listed tools `eve__tool` will run.** `callableByName` accepts
  deferred entries and any listed tool eve runs itself. It rejects `eve__*`
  tools and provider-run or client-run tools.
- **Dispatch path.** After resolution, a call to an inline entry runs its
  `execute`. A call to a workflow tool or agent returns a `DISPATCHED` marker
  from inside the AI SDK. `toEntryStep` and `toEntryStream` drop the marker
  and rewrite the step so the harness sees the call as a call to its entry
  (`harness/execute-call.ts`). Only model history keeps `eve__tool`.
- **Nested actions are gone.** `harness/nested-actions.ts` and the tool-call
  action's `parentCallId` were deleted. The deferred-tools doc says code mode
  adds the field back. `parentCallId` survives only in subagent
  `session.started` metadata (`protocol/message.ts`).
- **Signatures.** `renderToolSignature` (`tools/signature.ts`) renders input
  and output JSON Schema as TypeScript, capped at 4,000 characters, with
  `Promise<unknown>` when there is no output schema. `eve__search` returns
  these signatures.
- **Connection results.** `toConnectionToolResult` already describes itself as
  "what the model receives for the call and what a code mode program receives
  later". MCP results arrive as `structuredContent`, otherwise as text, which
  is parsed as JSON when the tool declares no output schema. OpenAPI results
  arrive as untyped `{ status, statusText, body }`, because OpenAPI tools
  declare no output schema.
- **Tasks.** Every agent tool is a `serve` tool, and the `workflow` tool is a
  `task` tool. Each call returns a receipt, and the result arrives later in a
  `task.result` message (`docs/tools/tasks.md`).
- **`workflow()`.** `tools/provided/workflow.ts` runs `{ js }` in a durable
  workflow. The program step is pure QuickJS
  (`execution/dynamic-workflow/program-step.ts`). Each `ctx.agent()` call is a
  parking host call (`createParkingHostTool` in `shared/workflow-sandbox.ts`)
  that resumes from a signed continuation. Agent calls are capped by
  `maxSubagents`, which defaults to 100 and allows 1 through 128. The tool
  can call agents hidden with `tool: false`.
- **Reserved name.** `eve__execute` is reserved, and eval assertions reject it
  with "reserved for code mode" (`evals/reported-tool-name.ts`).

## Prior art

Read at pi
[`4ac0bd8`](https://github.com/earendil-works/pi/tree/4ac0bd8c7b96d72cb6a73226edc7c9ecaae1d14e)
(code mode shipped in 0.99.0; PR #10040 was closed without merging) and
opencode
[`v2@4617210`](https://github.com/anomalyco/opencode/tree/4617210822bdbb31e5749751afbfb4584ccedac8).
Both were read from source, not run.

|                       | pi                                                                                | opencode v2                                                                                  | eve (proposed)                                                   |
| --------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Tool                  | `codemode`, off by default; auto-enabled by code-mode MCP servers                 | `execute`, on by default                                                                     | `eve__execute`, per-agent `codeMode: true`                       |
| Input                 | JSON `{ code }`, plus a Lark grammar for raw JavaScript on OpenAI                 | JSON `{ code }`                                                                              | JSON `{ code }`; grammar form later, gated by evals              |
| Callable from code    | Active direct tools, plus every code-mode or deferred tool                        | Only tools with `codemode !== false`; direct and code tools are disjoint                     | Every catalog entry, plus every listed tool `eve__tool` accepts  |
| Built-in coding tools | Declared and callable                                                             | Direct only                                                                                  | Declared and callable                                            |
| Names in code         | Flat (`tools.mcp__server__tool`)                                                  | Nested by namespace                                                                          | Flat catalog names                                               |
| Catalog               | Tool description, budgeted at 3,000 tokens; deferred MCP tools never listed       | System prompt baseline plus appended deltas, budgeted at 2,000 tokens; invariant description | Existing `catalog` announcement, unchanged; no inline signatures |
| Discovery in code     | Async `searchTools`, `describeTool`, `describeNamespace`, `ALL_TOOLS`             | Synchronous `search()` with paging                                                           | Async `search()`, same result as `eve__search`                   |
| Untyped outputs       | `string`; MCP tools return the full `CallToolResult`                              | `string \| null`; MCP tools without a schema return `unknown`                                | `unknown`                                                        |
| Nested calls          | Same hooks; child ids `<parent>/<n>`; `parentToolCallId` events; record on parent | Same before and after hooks; share the parent's call id; progress rows                       | Standard actions with `parentCallId`                             |
| Permissions           | Extension `tool_call` hooks                                                       | Each leaf calls `permission.assert` and waits in memory                                      | Entry approval policies; the program parks durably               |
| Sign-in mid-program   | Throws "Run /mcp to sign in"                                                      | Throws "Sign in from /mcps"                                                                  | Parks until sign-in completes, then resumes                      |
| Runtime               | QuickJS WASM in a worker thread, 256 MB heap, no default timeout                  | In-process acorn interpreter, no default limits                                              | QuickJS (`@ai-sdk/code-mode`) in the app runtime, eve-set limits |
| Network               | None                                                                              | `fetch`, with no SSRF guard, permission check, or size cap                                   | None; HTTP goes through tools                                    |
| Extras                | `store`/`load`, `models.*`, `image()`                                             | File parts from child results                                                                | None at ship                                                     |

**What we take**

- From both: a fixed tool description with runtime rules only, TypeScript
  signatures rendered from schemas, `unknown` for missing output types,
  `console` capture, and errors returned as data.
- From pi: direct tools stay direct and are also callable from code, with no
  exposure enum. Flat names. Nested calls run every hook a direct call runs,
  and each carries a parent call id. The model learns direct tools' output
  types through their own definitions, not through the code tool. Failures
  list the calls that ran before them, with "they are not undone".
- From opencode: `execute` as the name, catalog changes delivered as appended
  messages, and MCP result handling (`structuredContent`, otherwise text
  parsed as JSON, and `isError` throws), which eve already matches.

**What we don't take**

- **Catalog in the tool description (pi).** Its listing changes whenever a
  server connects. eve's catalog stays in the append-only announcement.
- **Budgeted inline signatures (both).** #4400 decided the listing never names
  a deferred entry. Deferring a tool is the author's choice to keep it out of
  context, and code mode does not override that choice. `search()` and
  `eve__search` return signatures on demand.
- **Disjoint direct and code tools (opencode).** It forces the model to pick a
  surface for each tool. In eve, `deferred` already decides what is declared.
- **`fetch` without policy (opencode).** HTTP goes through `web_fetch` or
  connections, which enforce SSRF checks and authorization.
- **Failing on sign-in or approval (both).** eve's harness can park, so a
  program parks too.
- **`store`, `load`, and `models.*` (pi).** Session state and model calls
  already have eve surfaces (memory, Jev). Adding them to programs is a
  separate decision.

## Principles

1. **One dispatch path.** A nested call is a model call that a program
   issued. It shares everything after name resolution with `eve__tool`. No
   tool runs differently because a program called it.
2. **One name per entry.** The program, search results, protocol, approvals,
   stubs, and evals all use the catalog name, so deferring a tool, calling it
   directly, or calling it from code never renames it.
3. **Code mode composes; it does not decide visibility.** `deferred` decides
   what the model sees. `codeMode` decides only whether the model can script
   calls. Programs reach exactly what `eve__tool` reaches.
4. **Park, never fail, for waits.** Anything that waits for a person, a
   sign-in, a workflow run, or an agent parks the program durably, exactly as
   it parks a direct call.
5. **Fixed per deployment.** Whether `eve__execute` exists, its schema, and its
   description depend only on agent config and eve version.

## Design

### Authoring API

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.6-luna",
  codeMode: true,
});
```

- **`codeMode?: boolean`**, which defaults to `false`.
  - It applies to the agent that declares it, root or subagent. A root copy
    started by the `agent` tool follows the root.
  - It is static. Dynamic agent configuration can't set it, because that
    would let the `tools` array change between sessions of one deployment.
  - `defaultTools: false` doesn't remove `eve__execute`.
  - An authored `agent/tools/eve__execute.ts` is already a compile error under
    the `eve` namespace rule.
- **Output schemas are the authoring lever.** There is no per-tool code mode
  setting. A tool's `outputSchema` gives programs a typed result. See
  [Output types](#output-types).
- **Hidden agents.** Programs reach what `eve__tool` reaches, so an agent with
  `tool: false` can't be called from code. Set `tool: "deferred"` to keep an
  agent out of the tool list while letting programs call it. This replaces
  `workflow()`'s ability to call hidden agents.

### Model surface

**`eve__execute`**

- **Input.** One JSON schema, `{ code: string }`, with `required: ["code"]`
  and `additionalProperties: false`. The code is the body of an async
  function, so top-level `await` and `return` work.
- **Description.** Fixed for each deployment. It states runtime rules and
  names no tool. It mentions `eve__search` only when the agent has
  `eve__search`, the same way `eve__tool` adds its connections clause. A
  draft:

  > Run a JavaScript program that calls your tools and returns one JSON value.
  > Use it to chain, loop over, filter, or combine tool calls so intermediate
  > data stays out of the conversation. Call any tool you can use as
  > `await tools.<name>(input)`, using its exact name (`tools["name"]` when the
  > name isn't an identifier), including tools found with eve\_\_search.
  > `await search({ query })` searches the same way inside the program. Calls
  > resolve to the tool's output; a failed or denied call throws. There is no
  > fetch, file system, timers, or imports. `console.log` output is returned
  > with the result.

- **Presence.** The tool is present exactly when `codeMode` is `true`. It
  goes in the tool list after the other catalog tools.
- **Label.** People see `Run code`, then `Ran code, <n> calls`. Nested calls
  have their own labels.

**Listing.** The `catalog` announcement keeps its rules: kinds, capped
namespaces, capped connections, no deferred names, and appended only on
change. With code mode on, its first sentence adds one fixed clause: "or call
several from eve__execute as `tools.<name>(input)`". The clause is fixed per
deployment, so it adds no churn.

**Direct tools' output types.** A model writing a program needs to know what
a direct tool returns, and the provider tool definition carries no output
type. With code mode on, each direct tool a program can call, and that has an
output schema, gets one appended line, the same way the `endsTurn` note is
appended (`describeEntry`):

```text
In eve__execute, tools.read_file(input) resolves to: { content: string; path: string; totalLines: number; truncated: boolean; nextOffset?: number; image?: { ... } }
```

The line is a pure function of the schema, capped at 1,000 characters, and
omitted when the output is `unknown`. Deferred entries get their output types
from the `signature` in search results.

### Programs

**Globals**

```ts
declare const tools: Record<string, (input?: object) => Promise<unknown>>;
declare function search(opts: { query: string; limit?: number }): Promise<{
  results: Array<
    | { tool: string; description: string; signature: string }
    | { skill: string; description: string; path?: string }
  >;
  unavailable?: Array<{ connection: string; error: string }>;
}>;
declare const console: Pick<Console, "log" | "info" | "warn" | "error">;
```

- **`tools.<name>(input)`** calls the entry with that exact catalog name.
  `input` defaults to `{}`. A connection's own name is its sign-in entry, so
  `await tools.linear()` signs the user in and parks until they finish, as
  `eve__tool({ name: "linear" })` does.
- **`search()`** is `eve__search`, with the same input, ranking, namespace
  queries, 10-second listing bound, and result. It is an async host call, so
  searches can run concurrently and a search can count toward the call limit.
  Skill hits tell the model what to load with `eve__skill`; programs don't
  load skills.
- **Nothing else.** There is no `fetch`, file system, timers, imports, or
  ambient state. Guest `Date` and `Math.random()` are deterministic across
  replay.

**What programs can call:** whatever `eve__tool` can call
(`callableByName`), minus tools that end the turn:

| Entry                                                | From code | Why                                                                  |
| ---------------------------------------------------- | --------- | -------------------------------------------------------------------- |
| Deferred tools, workflow tools, agents               | Yes       | Catalog entries                                                      |
| Connection tools and connection sign-in entries      | Yes       | Catalog entries                                                      |
| Listed tools eve runs (`bash`, `read_file`, …)       | Yes       | `eve__tool` accepts them                                             |
| `ask_question`, `sleep`, and other workflow tools    | Yes       | They park the program like any workflow tool                         |
| `eve__*` (search, tool, skill, task, reply, execute) | No        | eve's own surface; `search()` replaces `eve__search` inside programs |
| Provider-run and client-run tools (`web_search`)     | No        | eve never runs them, so it can't return their result to a program    |
| `endsTurn` tools (`no_reply`) and the final output   | No        | They end the turn, which only the model may do                       |

A name a program can't call fails the same way `eve__tool` fails: with the
closest names, or with `"<name>" is in your tool list; call it directly.`

**Agents in programs**

- **Awaited.** An agent call resolves to the agent's reply text, or to its
  structured value when `outputSchema` is given. It never returns a task
  receipt. The `eve__execute` call parks durably while the child runs.
- **Input.** The input is the agent tool's input without `taskId`, plus an
  optional `outputSchema`. The program is a caller, like `ctx.agent`, and
  `outputSchema` stays a caller-side option, as
  [tasks](./eve-tasks.md) requires. Every call starts a new child session, as
  `workflow()` does today.
- **Owned by the call.** Child sessions belong to the `eve__execute` call, not
  to the model's task table. `eve__task_wait` doesn't see them, and they end
  when the call settles. Cancelling the call or the turn cancels them.
- **Failures throw.** A failed child turn rejects at its call, so the program
  can catch it.
- **The same rule covers `task` and `serve` workflow tools.** From code they
  resolve to their first result instead of a receipt.

**Result**

- **Completed.** The model receives `{ result, logs?, calls }`. `result` is the
  JSON return value. `calls` lists each nested call's catalog name and final
  status, bounded at 256 entries.
- **Failed.** The model receives `{ error, logs?, calls }`, with the error
  message and the guest stack location. `calls` shows what ran before the
  failure, with the note that completed calls are not undone. The tool result
  is an error result.
- **Size.** What reaches the model is capped at 10,000 estimated tokens,
  keeping the head and tail with a truncation note, as pi does. Programs
  should return only what the model needs.
- **Raw values in programs.** Programs receive each call's raw output, never
  its `toModelOutput` projection. MCP media results arrive as content blocks.
  Forwarding media from a program to the model is out of scope at ship.

### Execution and parking

```text
model step ── eve__execute({ code }) ── program runs (QuickJS, app runtime)
                                           │ tools.x(input)
                                           ▼
                          step catalog: resolve → validate input
                    ┌──────────────────────┴───────────────────────┐
         inline entry, approval not                 approval asks, sign-in needed,
         needed: runs now, result in ledger         workflow tool, agent, question
                    │                                              │ interrupt
                    ▼                                              ▼
          program completes → tool result     execute call parks; harness dispatches
          in the same model step              the batch on the direct-call path
                                              (one action per call, parentCallId)
                                                                   │ batch settles
                                                                   ▼
                                       program resumes from the continuation; the
                                       ledger replays completed calls without
                                       running them → completes or parks again
```

- **Where it runs.** Programs run in the app runtime, never the sandbox, so
  credentials stay app-side. Sandbox tools reach the sandbox through their
  normal executors.
- **Inline first.** `eve__execute` is an inline tool. Its program runs inside
  the model step, and calls to inline entries that need no approval run
  immediately. Crash semantics match today's inline tools: a crashed step
  re-runs its program, and the idempotency guidance for `defineTool` applies.
- **Parking.** A call that must wait raises a code-mode interrupt. Concurrent
  calls that interrupt together form one batch. The step ends with the
  `eve__execute` call pending. The harness stores the continuation in session
  state and dispatches each pending call exactly as if the model had called
  it:
  - an approval request for the nested action;
  - a sign-in through the shared connection helper;
  - a workflow run;
  - a child session.

  When every call in the batch settles, a program step resumes with their
  resolutions. Calls first reached after the replay frontier run normally, and
  may park again.

- **Resolutions.** A completed call resolves with its raw output. A failed
  call, a denied approval (with the denial note), a failed sign-in, or a
  cancelled call rejects with an error the program can catch.
- **Continuation key.** The signing key comes from a durable step, reusing
  `createWorkflowProgramContinuationSecurityStep`, and is bound to the call.
  Continuations carry every recorded result in plaintext base64. They live in
  session state and the workflow event log, which already hold the same
  results.
- **Steering.** A new message while the program runs inline applies at the
  next step boundary, as it does for any inline tool. A new message while the
  call is parked aborts it the way it aborts an `execute` workflow tool. eve
  withdraws pending approvals and questions, cancels owned child sessions, and
  settles the call with `{ error: "Stopped early because a new message arrived.", calls }`.
- **Turn cancellation** cancels the call and everything it owns.

**Limits.** These are fixed, and there are no settings at ship:

| Limit                          | Value                                            | Notes                                                                         |
| ------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Nested calls per execute call  | 256                                              | The `maxBridgeRequests` default. Agent calls and searches count toward it     |
| In-flight nested calls         | 32                                               | The AI SDK default                                                            |
| Guest compute per program step | 30 s of guest execution (`cpuTimeoutMs`)         | Excludes time spent waiting on nested calls; needs run#78, see open questions |
| Memory, stack, source, console | AI SDK defaults (64 MiB, 2 MiB, 256 KiB, 64 KiB) |                                                                               |
| Nested input and output        | 1 MiB input, 4 MiB output per call               |                                                                               |
| Continuation size              | 8 MiB                                            | Over the cap, the call fails and tells the model to return less               |
| Model-facing result            | 10,000 estimated tokens                          | Head and tail kept                                                            |

Errors over a limit name the limit, such as
`EXECUTE_CALL_LIMIT_REACHED: a program may make at most 256 calls; "linear__get_issue" was not called.`

### Nested calls on the protocol

- **Standard actions.** Each nested call emits the standard action events
  under its catalog name, with a restored optional `parentCallId` that points
  to its `eve__execute` call. `eve__execute` is itself an action.
- **Child call ids** are `<executeCallId>/<n>`, in the order calls start. That
  order is deterministic across replay. Child sessions record the nested call
  id as their `parentCallId`.
- **Everything keyed by name keeps working:** approval policies, `approvalKey`,
  recorded approve-always decisions, labels, display titles, hooks, audience
  policy, tool stubs (matched as direct calls, through `stubbedCall`), and
  `t.calledTool(...)`.
- **Replay.** Resuming from a continuation doesn't re-emit events for
  completed calls. A crashed step re-emits them under the same ids, because
  the ids derive from program order.
- **Clients** may group actions by `parentCallId`. Clients that ignore the
  field render them flat. The TUI, task card, and framework templates show
  nested calls under the execute row.
- **Model history** holds only the `eve__execute` call and its result.
- **Evals.** `t.calledTool("eve__execute")` becomes valid for agents with code
  mode on. `reported-tool-name.ts` stops rejecting the name.

`parentCallId` on actions is an additive protocol change. It ships with
protocol docs.

### Output types

- **No schema.** Callable, and typed `Promise<unknown>`. The description tells
  the model to narrow at runtime, or to return the value and read it in the
  next step.
- **Validation.** When an entry declares an output schema, its output is
  validated before a program sees it. A mismatch rejects with
  `InvalidToolOutput`, so a signature never advertises a shape the tool
  doesn't return. Direct and `eve__tool` calls are unchanged.
- **OpenAPI.** Each operation derives `outputSchema` from its success response
  schema, so `body` is typed. This also improves `eve__search` signatures for
  agents without code mode.
- **Build warning.** For agents with `codeMode: true`, `eve build` and
  `eve dev` warn once for each authored tool without an `outputSchema`, and
  name the tool file.

### Cache invariants

These extend the six in [deferred tools](./deferred-tools.md#cache-invariants):

1. **Fixed tools.** The presence, schema, and description of `eve__execute`
   depend only on `codeMode` and the eve version.
2. **Deterministic notes.** The output-type line on direct tools is a pure
   function of the schema.
3. **Programs add nothing.** A nested call, park, sign-in, child session, or
   resume never adds a definition or a system message.
4. **Listing unchanged.** The only difference is the fixed code-mode clause.

## Removing `workflow()`

`eve__execute` covers everything `workflow()` does: fan-out and fan-in over
agents, structured output, catchable failures, and durable parking. It also
calls tools and connections. Keeping both would give models two JavaScript
tools.

- **Removed.** `workflow()`, `eve/tools/workflow`, and
  `execution/dynamic-workflow/tool.ts`. An agent that imports it fails to
  compile with: `workflow() was removed. Set codeMode: true in agent.ts; programs call agents as tools.<name>({ message }).`
- **Survives, generalized.** The program step, the continuation security
  step, and `shared/workflow-sandbox.ts` move behind `eve__execute`. The
  parking host tool becomes the interrupt for every waiting call kind.
- **Behavior differences to document in the migration:**
  - The call holds the turn instead of running as a task.
  - Hidden agents need `tool: "deferred"`.
  - The 100-agent default becomes the 256-call limit.
  - The program's input is `code`, not `js`.

## Rollout

### Pull requests

Stacked, following the #4400 shape.

| PR            | Scope                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [1/3] Runtime | `codeMode` on `defineAgent`; `eve__execute` and its description; programs on the generalized program step; nested resolution through the step catalog; inline runs, interrupts, and the program state in session state; nested approval, sign-in, workflow, and agent dispatch; steering and cancellation; `parentCallId`; labels and client grouping; removal of `workflow()` |
| [2/3] Types   | Output-type notes on direct tools; output validation for program calls; OpenAPI output schemas; the build warning                                                                                                                                                                                                                                                              |
| [3/3] Tests   | Every new test, below                                                                                                                                                                                                                                                                                                                                                          |

Docs and a `minor` changeset go with [1/3]: it adds a public option, changes
the protocol, and removes `eve/tools/workflow`. [2/3] carries a `patch`.

### Tests

- **Captured-request unit test.** One session with code mode on drives
  programs through:
  - an inline tool, a deferred tool, and a connection tool in one program;
  - an approval mid-program, both approved and denied;
  - a sign-in mid-program;
  - a foreground workflow tool;
  - parallel agents with `outputSchema`;
  - `search()` followed by a call in the same program;
  - a call limit hit;
  - a steering message while parked;
  - compaction between programs.

  It asserts the cache invariants and that nested calls never reach history.

- **Replay.** After a resume, completed calls aren't re-invoked, events
  aren't re-emitted, and child ids are stable.
- **E2E.**
  - Extend `agent-deferred-tools` with a code-mode agent. Its world suites run
    on the mock model, which must call `eve__execute`. They cover approval
    keyed to the nested entry, the workflow tool parking and resuming, an
    agent fan-out, and `t.calledTool` on nested calls.
  - Its real-model suite covers cache reads after programs.
  - Move the `workflow()` evals in `agent-subagents` and `agent-cancellation`
    to `eve__execute`, written fresh against the new surface.
- **New real-model evals**, written as process narratives:
  - Alice reconciles orders against payments and support tickets across two
    connections.
  - Bob reads an export with `read_file` and checks each row against a
    connection.
  - A fan-out to parallel agents, combined with connection data.
  - An MCP server with untyped outputs.

### Measurements and ship gate

Run one task set in two arms, code mode off and code mode on, at a moderate
and a large tool count. Measure task success, model calls, input tokens, cache
read ratio, and latency.

- **Composition tasks.** Code mode must cut model calls and input tokens with
  no loss in success.
- **Single-call tasks.** No regression in success or latency.
- **Cache.** No regression in cache reads after programs or after
  discovery.
- **World suites.** No new nondeterminism.
- **Recorded, not gated:** whether agents with code mode still call
  `eve__tool`. If they almost never do, a follow-up drops `eve__tool` for those
  agents.

Defaulting `codeMode` to `true` is a separate decision, made after shipping
with this data.

### Docs

- `agent-config`: `codeMode`.
- `concepts/built-in-tools`: an `eve__execute` section, and the reserved-name
  list.
- `tools/overview`: why output schemas matter.
- `tools/workflows`: remove the `workflow` tool section and add the migration.
- `tools/tasks`: agent and task calls inside programs.
- `subagents`: `tool: "deferred"` for agents only programs should call.
- `connections/overview`: connections in programs, and sign-in mid-program.
- `evals/assertions`: nested calls and `eve__execute`.
- Protocol docs: `parentCallId`.

## Decisions and alternatives considered

| Decision                      | Chosen                                                                                       | Rejected                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                          | `eve__execute`, reserved by #4400                                                            | `execute` (an ordinary authored name since #4400); `codemode`                                                                                                                 |
| Enablement                    | `codeMode: true` on `defineAgent`, fixed per deployment, off by default until measured       | Always on (unmeasured, and costs tokens for agents that never compose); derived from declarations (nothing in declarations signals intent); a dynamic setting (flips `tools`) |
| Relation to the catalog tools | Added beside `eve__search`, `eve__tool`, and `eve__skill`                                    | Replacing `eve__tool` at ship (one-call JSON calls are cheaper and well trained; revisit with data); search only inside code (opencode)                                       |
| Dispatch                      | Every nested call resolves through the step catalog and runs on the direct-call path         | A workflow-tool program like `workflow()`, re-implementing approval, sign-in, and dispatch inside a workflow run (a second path for every job)                                |
| Execution                     | Inline first; interrupt only to wait; ledger replay                                          | Interrupt on every call (one durable step per call, with latency on every sequential `await`); a program that can't pause (pi, opencode)                                      |
| Names in code                 | Flat catalog names                                                                           | Nested owner paths such as `tools.crm.api.list_issues` (sketched in #4400; needs owner records and a second naming scheme)                                                    |
| What code can call            | Whatever `eve__tool` accepts, minus turn-ending tools                                        | Per-tool `codemode` flags (opencode); pi's exposure enum; deferred entries only                                                                                               |
| Skills                        | Found by `search()`, loaded by the model with `eve__skill`                                   | Loading from a program (a skill instructs the model, not a program; neither pi nor opencode does it)                                                                          |
| Agents in code                | Awaited replies owned by the execute call; `outputSchema` allowed; a new child per call      | Task receipts in programs; continuing a child by `taskId` at ship                                                                                                             |
| Catalog presentation          | Existing listing plus one fixed clause; output types on direct tools; signatures from search | Budgeted inline signatures (overrides `deferred`); catalog in the tool description (pi)                                                                                       |
| Untyped outputs               | `Promise<unknown>`; build warning when code mode is on                                       | Requiring output schemas; `string` (pi)                                                                                                                                       |
| Input form                    | JSON `{ code }` at ship                                                                      | Lark grammar at ship (provider-specific declaration, history normalization, and unverified on AI Gateway); see open questions                                                 |
| `workflow()`                  | Removed in the same release                                                                  | Keeping a second JavaScript tool; a transition period                                                                                                                         |
| Network                       | None in programs                                                                             | `fetch` (opencode has no SSRF guard or permission check)                                                                                                                      |
| Limits                        | Fixed AI SDK defaults plus eve caps on continuation and result size                          | Settings on `codeMode` at ship                                                                                                                                                |

## Open questions

- **Compute timeout versus nested waits.** In `run` 2.1, `timeoutMs` is a
  wall-clock deadline that includes time awaiting host calls. The only compute
  bound is a hidden 10,000-check interrupt cap, which replay spends again
  ([vercel-labs/run#76](https://github.com/vercel-labs/run/issues/76)).
  [vercel-labs/run#78](https://github.com/vercel-labs/run/pull/78) adds
  `cpuTimeoutMs`, which counts only guest execution, and removes the cap.
  eve then sets `cpuTimeoutMs` tight and the wall-clock `timeoutMs` from the
  step's budget. `@ai-sdk/code-mode` still needs a matching
  `executionPolicy.cpuTimeoutMs`.
- **Raw JavaScript input.** pi declares a Lark grammar for OpenAI models so
  the model writes source instead of a JSON-escaped string. eve's
  `@ai-sdk/openai` 4.0.84 exposes `customTool`. Shipping it means a
  provider-specific declaration, and normalizing calls to `{ code }` in
  history so a session can switch providers. It is worth one eval arm, after
  ship.
- **Continuing an agent from code.** `workflow()` can't, and neither can this
  design at ship. If evals show programs re-briefing the same agent, add a
  returned handle, not a raw `taskId`.
- **Background programs.** `workflow()` ran as a task. Programs here hold the
  turn. If long fan-outs need the conversation to continue, a later option can
  run an `eve__execute` call as a task.
- **Media out of programs.** Images from `read_file` or MCP content can't
  reach the model through a program at ship. opencode attaches them, and pi
  has `image()`.
- **Default on.** Revisit after the ship gate.

## Evidence limits

- **Prior art is from source reading.** pi `4ac0bd8` and opencode `v2@4617210`
  were read, not run. Neither publishes cache-hit measurements.
- **Nothing is measured yet.** Cache, cost, and success numbers come from the
  measurement arms above.
- **Inline-first is unproven at scale.** Its performance assumes most nested
  calls don't park. Programs that park on every call get one program step per
  call. That is no worse than one model step per call, but it isn't free.
- **Continuation growth.** The ledger re-serializes every recorded result on
  each resume. The 8 MiB cap is an estimate to tune against real programs.
