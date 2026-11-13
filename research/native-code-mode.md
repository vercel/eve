---
issue: TBD
status: proposed
last_updated: "2026-11-13"
---

# Native code mode

## Summary

[Deferred tools and skills](../docs/concepts/built-in-tools.md) (#4400) gave every agent one
catalog of tools, agents, connection tools, and skills, reached through fixed
tools that never change the `tools` array. That work reserved one more name
for code mode. This doc fills it in.

```ts
eve__execute(opts: { code: string }): Promise<{
  result?: unknown; // the program's JSON return value
  error?: string; // why the program failed, when it did
  logs?: string[]; // console output
  calls: Partial<Record<"completed" | "failed" | "rejected" | "interrupted" | "abandoned", number>>;
  notCompleted?: Array<{ tool: string; outcome: string; input: string }>;
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
  The setting is fixed for each deployment. Everything else in the catalog
  design stays as it is: `eve__search`, `eve__tool`, and `eve__skill` keep
  their behavior.
- **A program is a batch of `eve__tool` calls.** Each `tools.<name>(input)`
  call resolves through the step catalog and runs on the same path as a
  model-issued call. That covers input validation, approval, connection
  sign-in, workflow runs, child sessions, stubs, hooks, labels, and eval facts.
- **One name everywhere.** Programs call entries by their flat catalog names,
  such as `tools.linear__list_issues` and `tools.crm__api__list_issues`. These
  are the names used in `eve__search`, `eve__tool`, stream events, approvals,
  and evals. There is no second, nested naming scheme.
- **The program runs in its own step.** The model step saves the call first.
  The program then runs in a program step, and calls that don't wait run
  inline inside it. The program stops only for a call that must wait: an
  approval, a sign-in, a workflow tool, an agent, or a question. It then holds
  no compute and resumes from a signed replay ledger.
- **A crash doesn't repeat completed calls.** The code and the call id are
  saved before the first side effect, so recovery never asks the model to
  write the program again. Recorded calls replay, and each nested call has a
  stable id to use as an idempotency key.
- **Approval is per call.** Each nested call goes through its own tool's
  approval policy, with its own input and prompt. Running a tool from a
  program never skips its approval.
- **Agents are awaited, not tasked.** Inside a program, an agent call resolves
  to the agent's reply. The `eve__execute` call owns the child sessions, so they
  never appear in the model's task table.
- **`workflow()` is removed.** `eve__execute` does everything the `workflow`
  program tool does and more.
- **Cache stable.** The `eve__execute` definition depends only on `codeMode`
  and the eve version, and names no other tool. A program never adds a
  definition.

## Why now

- **The catalog exists.** #4400 shipped a step catalog that resolves any name
  to its entry and runs it like a direct call (`execution/catalog/`,
  `harness/execute-call.ts`). Code mode needs nothing else for discovery or
  routing. All it adds is a runtime that issues many calls per model call.
- **Composition is where round trips go.** Reconciling, filtering, fanning
  out, and joining across tools all cost one model step per call today, and
  every intermediate result stays in history for the rest of the session.
  Programs remove both costs.
- **Users are building it themselves.** @YoussBim asked for the `workflow`
  tool to call ordinary tools, for a loop that emails 150 leads. In the
  meantime they wrapped a code-mode runtime in a tool, and had to rebuild two
  things eve already owns: the email tool's approval, which a direct `execute`
  call skips, and deduplication for a step that re-runs after a crash. Both
  are requirements of this design.
- **Prior art converged.** pi and opencode v2 both ship code mode, with
  signatures rendered from schemas and budgeted catalogs. Neither can pause a
  program mid-flight. Durable pause and resume is what eve adds.
- **The runtime is in place.** Since #5187 eve runs model-written JavaScript
  in QuickJS on the vendored `run` runtime (pinned at 2.1.8 in
  `packages/eve/package.json`) for the `workflow` tool. It already has signed
  continuations whose key comes from a durable step, a 30 s guest compute
  limit, and a 5 min wall-clock limit
  (`execution/dynamic-workflow/program-step.ts`).

## Current state

- **Step catalog.** `buildStepCatalog` (`execution/catalog/step-catalog.ts`)
  builds one table per step from authored, dynamic, and subagent entries,
  split into `advertised` and `deferred` maps. Connection tools resolve by
  prefix ownership (`connectionEntryNamed`). `eve__tool` and `eve__skill` are
  routes: the catalog's `resolve` turns a route call into the call to the
  entry it names, and eve resolves every call before it runs one.
- **Which listed tools `eve__tool` will run.** `callableByName`
  (`execution/catalog/catalog-tools.ts`) accepts deferred entries and any
  listed tool eve runs itself. It rejects `eve__*` tools and provider-run or
  client-run tools.
- **Catalog tools are per session.** eve adds each catalog tool when the
  session first has something it reaches, including an entry a dynamic
  resolver returns mid-session, and then keeps it.
- **Calls on the stream.** Stream version 27 reports each call as
  `call.requested`, `call.started`, and `call.settled`, with outcomes
  `completed`, `failed`, `rejected`, `interrupted`, and `abandoned`. A call's
  `owner` is a model run, the call it runs inside (`{ callId }`), or its turn.
  Tool input streams as `call.input` records.
- **Crash recovery.** An interrupted step runs again from its checkpoint. A
  call whose start is in the recovered stream doesn't run again. The model
  reads a note of up to 20 such calls, each with up to 500 characters of
  input, and decides what to repeat (`harness/interrupted-attempt.ts`).
- **Signatures.** `renderToolSignature` (`tools/signature.ts`) renders input
  and output JSON Schema as TypeScript, with `Promise<unknown>` when there is
  no output schema. `eve__search` returns these signatures.
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
  workflow. The program step is pure QuickJS. Each `ctx.agent()` call
  interrupts the program through `run`'s host function context and resumes
  from a signed continuation. Agent calls are capped by `maxSubagents`, which
  defaults to 100 and allows 1 through 128. The tool can call agents hidden
  with `tool: false`. The host installs the `run` runtime only for agents
  whose manifest declares a program tool.
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
| Nested calls          | Same hooks; child ids `<parent>/<n>`; `parentToolCallId` events; record on parent | Same before and after hooks; share the parent's call id; progress rows                       | Standard `call.*` events owned by the `eve__execute` call        |
| Permissions           | Extension `tool_call` hooks                                                       | Each leaf calls `permission.assert` and waits in memory                                      | Entry approval policies; the program parks durably               |
| Sign-in mid-program   | Throws "Run /mcp to sign in"                                                      | Throws "Sign in from /mcps"                                                                  | Parks until sign-in completes, then resumes                      |
| Crash mid-program     | Not durable                                                                       | Not durable                                                                                  | Recorded calls replay; nested call ids are stable                |
| Runtime               | QuickJS WASM in a worker thread, 256 MB heap, no default timeout                  | In-process acorn interpreter, no default limits                                              | QuickJS (vendored `run`) in the app runtime, eve-set limits      |
| Network               | None                                                                              | `fetch`, with no SSRF guard, permission check, or size cap                                   | None; HTTP goes through tools                                    |
| Extras                | `store`/`load`, `models.*`, `image()`                                             | File parts from child results                                                                | None at ship                                                     |

**What we take**

- From both: a fixed tool description with runtime rules only, TypeScript
  signatures rendered from schemas, `unknown` for missing output types,
  `console` capture, and errors returned as data.
- From pi: direct tools stay direct and are also callable from code, with no
  exposure enum. Flat names. Nested calls run every hook a direct call runs,
  and each is tied to its parent call. The model learns direct tools' output
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
2. **One name per entry.** The program, search results, stream events,
   approvals, stubs, and evals all use the catalog name, so deferring a tool,
   calling it directly, or calling it from code never renames it.
3. **Code mode composes; it does not decide visibility.** `deferred` decides
   what the model sees. `codeMode` decides only whether the model can script
   calls. Programs reach exactly what `eve__tool` reaches.
4. **Park, never fail, for waits.** Anything that waits for a person, a
   sign-in, a workflow run, or an agent parks the program durably, exactly as
   it parks a direct call.
5. **Save before side effects.** The program's code and call id are durable
   before its first nested call runs, so recovery works from what eve
   recorded, not from what the model remembers.
6. **Fixed per deployment.** Whether `eve__execute` exists, its schema, and its
   description depend only on agent config and the eve version.

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
  - The manifest records it, so the host installs the `run` runtime as it
    does for a `workflow()` tool today.
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
  function, so top-level `await` and `return` work. It streams as `call.input`
  records like any tool input, so clients can show the program as the model
  writes it.
- **Description.** Fixed for each deployment. It states runtime rules and
  names no other tool. It doesn't mention `eve__search`, because a session
  can gain that tool mid-session and the description must not change with it.
  A draft:

  > Run a JavaScript program that calls your tools and returns one JSON value.
  > Use it to chain, loop over, filter, or combine tool calls so intermediate
  > data stays out of the conversation. Call any tool you can use as
  > `await tools.<name>(input)`, using its exact name (`tools["name"]` when the
  > name isn't an identifier). `await search({ query })` finds tools that
  > aren't in your tool list. Calls resolve to the tool's output; a failed or
  > rejected call throws. Start calls that don't depend on each other together
  > with `Promise.all`, so any that need approval are asked at once. There is
  > no fetch, file system, timers, or imports. `console.log` output is
  > returned with the result.

- **Presence.** The tool is present exactly when `codeMode` is `true`. It
  goes in the tool list after the other catalog tools.
- **Label.** People see `Run code`, then `Ran code, <n> calls`. Nested calls
  have their own labels.

**Listing.** The `catalog` announcement keeps its rules: kinds, capped
namespaces, capped connections, no deferred names, and appended only on
change. With code mode on, its first sentence adds one fixed clause: "or call
several from eve__execute as `tools.<name>(input)`".

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
  queries, 10-second listing bound, and result. It always exists, and returns
  no results in a session with nothing deferred. It is an async host call, so
  searches can run concurrently and count toward the call limit. Skill hits
  tell the model what to load with `eve__skill`; programs don't load skills.
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
| Tools with `endsTurn`, boolean or function           | No        | They end the turn, which only the model may do                       |

A name a program can't call fails the same way `eve__tool` fails: with the
closest names, or with `"<name>" is in your tool list; call it directly.`

Each program step builds its catalog the way a model step does. A call first
reached after a resume resolves against the catalog of that step, so a tool a
dynamic resolver no longer returns fails as an unknown name. A replayed call
never resolves again.

**Agents in programs**

- **Awaited.** An agent call resolves to the agent's reply text, or to its
  structured value when `outputSchema` is given. It never returns a task
  receipt. The `eve__execute` call parks durably while the child runs.
- **Input.** The input is the agent tool's input without `taskId`, plus an
  optional `outputSchema`. For an `agent({ models })` tool, that includes
  `model`. The program is a caller, like `ctx.agent`, and `outputSchema` stays
  a caller-side option, as [tasks](../docs/tools/tasks.md) requires. Every
  call starts a new child session, as `workflow()` does today.
- **Owned by the call.** Child sessions belong to the `eve__execute` call, not
  to the model's task table. `eve__task_wait` doesn't see them, and they end
  when the call settles. Cancelling the call or the turn cancels them.
- **Failures throw.** A failed child turn rejects at its call, so the program
  can catch it.
- **The same rule covers `task` and `serve` workflow tools.** From code they
  resolve to their first result instead of a receipt.

**Result**

- **Completed.** The model receives `{ result, logs?, calls, notCompleted? }`.
  `result` is the JSON return value. `calls` counts nested calls by outcome.
- **Failed.** The model receives `{ error, logs?, calls, notCompleted? }`,
  with the error message and the guest stack location, and the note that
  completed calls are not undone. The tool result is an error result.
- **`notCompleted`** lists the first 20 nested calls that didn't complete,
  whether or not the program caught them: the tool, the outcome, and up to
  500 characters of input. These are the bounds of today's interrupted-step
  note. It is how the model learns which lead a rejected or interrupted send
  was for.
- **Size.** What reaches the model is capped at 10,000 estimated tokens,
  keeping the head and tail with a truncation note, as pi does. Programs
  should return only what the model needs.
- **Raw values in programs.** Programs receive each call's raw output, never
  its `toModelOutput` projection. MCP media results arrive as content blocks.
  Forwarding media from a program to the model is out of scope at ship.

### Execution and parking

```text
model step ──── eve__execute({ code }) ── the step saves; the call is pending
                                           │
                                           ▼
program step ── the program runs (QuickJS, app runtime)
                                           │ tools.x(input)
                                           ▼
                 step catalog: resolve → validate input → approval policy
                    ┌──────────────────────┴───────────────────────┐
         inline entry, cleared to run:              approval asks, sign-in needed,
         runs now, inside the program step          workflow tool, agent, question
                    │                                              │ interrupt
                    ▼                                              ▼
          program completes → tool result           the step ends with a continuation;
          → next model step                         the harness dispatches the batch on
                                                    the direct-call path, each call
                                                    owned by the eve__execute call
                                                                   │ batch settles
                                                                   ▼
                                       the next program step resumes from the
                                       continuation; recorded calls replay without
                                       running → completes or parks again
```

- **Where it runs.** Programs run in the app runtime, never the sandbox, so
  credentials stay app-side. Sandbox tools reach the sandbox through their
  normal executors.
- **Its own step.** The model step ends with the `eve__execute` call pending,
  as it does for a call to an `execute` workflow tool, and the turn waits.
  The program runs in a program step that follows. This costs one durable
  step per program, not one per call. In return, the code and the call id are
  saved before any nested call runs.
- **Inline inside the program step.** A call to an inline entry that needs no
  approval runs immediately, inside the program step.
- **Parking.** A call that must wait raises an interrupt. Concurrent calls
  that interrupt together form one batch. The program step ends with a
  continuation in session state, and the harness dispatches each pending call
  exactly as if the model had called it:
  - an approval request for the nested call;
  - a sign-in through the shared connection helper;
  - a workflow run;
  - a child session.

  When every call in the batch settles, the next program step resumes with
  their resolutions. Calls first reached after the replay frontier run
  normally, and may park again.

- **Resolutions.** A completed call resolves with its raw output. A failed
  call, a rejected approval (with the denial reason), a failed sign-in, or an
  interrupted call rejects with an error the program can catch.
- **Continuation key.** The signing key comes from a durable step, reusing
  `createWorkflowProgramContinuationSecurityStep`, and is bound to the call.
  Continuations carry every recorded result in plaintext base64. They live in
  session state and the workflow event log, which already hold the same
  results.
- **Steering.** The call behaves like an `execute` workflow tool for its
  whole life. A message sent with `turnPolicy: "queue"` waits for it. A
  steering message aborts it: nested calls already running finish and keep
  their results, no new call starts, eve withdraws pending approvals and
  questions, cancels owned child sessions, and settles the call with
  `{ error: "Stopped early because a new message arrived.", calls }`.
- **Turn cancellation** cancels the call and everything it owns.

### Crash recovery

A crash, timeout, or redeploy during a program step retries that step. It
never re-runs the model step, so the same code runs under the same call id.
For each nested call the retried step reaches:

| What eve recorded for the call                           | What the program gets                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Its outcome, in the continuation or the recovered stream | The recorded output or error, without running the call                                    |
| Its start, but no outcome                                | A rejection that says the call was interrupted and may have taken effect; it isn't re-run |
| Nothing                                                  | The call runs                                                                             |

- **This is the existing rule, applied per nested call.** A call whose start
  is in the recovered stream doesn't run again, and what the interrupted
  attempt left open ends `abandoned`. The difference is the reader: the
  program gets a catchable error at the call, instead of the model reading a
  note.
- **An uncaught interruption fails the program.** The model then reads
  `{ error, calls, notCompleted }`, which names the interrupted call's input,
  and decides whether to check on it before continuing.
- **Stable ids.** A nested call's `ctx.callId` is `<callId>/<n>`, the same on
  every resume and retry. A tool passes it to its upstream API as an
  idempotency key, as `ctx.callId` is documented today, for example
  `` `${ctx.session.id}:${ctx.callId}` ``. Connection `headers` and provided
  argument callbacks receive the same id.
- **Not exactly once.** The limits of step recovery still apply: a call that
  began before its start reached the stream can run again. Tools with
  irreversible effects keep their idempotency keys.
- **Interrupted-step budget.** A turn still fails with `STEP_INTERRUPTED`
  after more than three interrupted steps.
- **Replay policies.** If a per-tool replay policy lands (#5099, #5108),
  nested calls follow it the same way direct calls do.

### Approvals in programs

- **Each nested call is gated on its own.** eve runs the entry's `approval`
  policy and the agent-wide policy for every nested call, with that call's
  `toolName`, `toolInput`, and `callId`. The approval prompt and the channel's
  approval card show that call's input, so a person approving an email sees
  the exact text.
- **A waiting call hasn't started.** An approved call runs after the policy's
  recheck. A denied call settles `rejected` and throws in the program with
  the denial reason, so a program can skip that item and continue.
- **Calls started together ask together.** A batch opens all its approvals at
  once, and `turn.paused` lists them. A sequential loop asks one at a time,
  which is why the description tells the model to start independent calls
  together.
- **Existing policies cover loops.** `once()` asks for the first call and
  lets the rest run. A policy function can return `"approved"` from session
  state, for example when a person already approved a campaign in the
  conversation.
- **The program itself isn't gated.** Like `eve__tool`, `eve__execute` has no
  approval of its own. Policies see the entries a program calls, and nothing
  approves a program as a whole.

### Limits

These are fixed, and there are no settings at ship:

| Limit                          | Value                              | Notes                                                                 |
| ------------------------------ | ---------------------------------- | --------------------------------------------------------------------- |
| Nested calls per program       | 1,024                              | Tool calls and searches. An estimate to tune                          |
| Agent calls per program        | 128                                | The `workflow()` ceiling today. Each is a child session               |
| Inline calls running at once   | 32                                 | eve queues the rest. Parked calls don't count                         |
| Guest compute per program step | 30 s of guest execution            | Excludes time spent waiting on nested calls; replay counts, see below |
| Wall clock per program step    | 5 min                              | Includes inline nested calls; parked calls don't count                |
| Memory, stack, source, console | 64 MiB, 2 MiB, 256 KiB, 64 KiB     | The `workflow()` values today                                         |
| Nested input and output        | 1 MiB input, 4 MiB output per call | The `workflow()` values today                                         |
| Continuation size              | 8 MiB                              | Over the cap, the call fails and tells the model to return less       |
| Model-facing result            | 10,000 estimated tokens            | Head and tail kept                                                    |

- **Why two call limits.** A loop over 150 leads with a lookup and a send per
  lead is 300 calls, over the 256 the first draft allowed. Tool calls are
  cheap to allow; child sessions are not.
- **`run`'s in-flight limit equals the call limit.** `run` fails a program
  that exceeds its in-flight limit instead of queueing, which is why
  `workflow()` raised it to the call limit (#972). eve throttles running
  inline calls itself.
- **Each program step starts a fresh compute budget.** A resume replays the
  guest source from the start, so its 30 s must cover the replayed prefix
  plus the new work. Over the limit, the program fails instead of parking.

Errors over a limit name the limit, such as
`EXECUTE_CALL_LIMIT_REACHED: a program may make at most 1024 calls; "linear__get_issue" was not called.`

### Nested calls on the stream

- **Standard call events.** Each nested call emits `call.requested`,
  `call.started`, and `call.settled` under its catalog name, with
  `owner: { callId }` naming its `eve__execute` call. Stream version 27 already
  defines that owner, so this adds no field and no event type. `eve__execute` is
  itself a call.
- **Child call ids** are `<callId>/<n>`, in the order calls start. Child
  sessions record the nested call as their parent.
- **Everything keyed by name keeps working:** approval policies, recorded
  `once()` approvals, labels, `label: false`, hooks, audience policy, tool
  stubs, and `t.calledTool(...)`.
- **Replay.** Resuming from a continuation, or retrying a step, doesn't emit
  events again for recorded calls.
- **Clients** group calls by `owner`. Clients that ignore it render them
  flat. The TUI, task card, and framework templates show nested calls under
  the `eve__execute` row.
- **Model history** holds only the `eve__execute` call and its result.
- **Evals.** `t.calledTool("eve__execute")` becomes valid for agents with code
  mode on, and nested calls are reported under their own names.
  `reported-tool-name.ts` stops rejecting the name.
- **Tracing.** A nested call's span is a child of the `eve__execute` call's
  span, and the trace content policy applies to the code, logs, and nested
  inputs and outputs as it does to any call.

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
- **Build warning.** For an agent with code mode on, `eve build` and
  `eve dev` warn once for each authored tool without an `outputSchema`, and
  name the tool file.

### Cache invariants

These extend the six from deferred tools (#4400):

- **Stable tools.** Calling, finding, or loading an entry never changes the
  `tools` array. A catalog tool joins it once, when the session first has
  something it reaches, and stays.
- **No session-specific text** in the system prompt or any tool description.
- **Append-only history.** Listing changes only append messages, and earlier
  messages are never rewritten.
- **No system-message fallback.** Announcements are always messages appended
  to history, including on the step that runs approved calls.
- **Deterministic rendering.** Listings are sorted, and a signature is a pure
  function of its schema. `eve__search` renders signatures only for the
  results it returns.
- **Calling an entry adds nothing.** An `eve__tool` call, skill load,
  approval, park, sign-in, child session, or resume never adds a definition.

Code mode adds:

1. **Fixed tool.** The presence, schema, and description of `eve__execute`
   depend only on `codeMode` and the eve version. The description
   doesn't depend on which catalog tools the session has.
2. **Deterministic notes.** The output-type line on direct tools is a pure
   function of the schema.
3. **Programs add nothing.** A nested call, park, sign-in, child session,
   resume, or retry never adds a definition or a system message.
4. **Listing unchanged.** The only difference is the fixed code-mode clause.

## Removing `workflow()`

`eve__execute` covers everything `workflow()` does: fan-out and fan-in over
agents, structured output, catchable failures, and durable parking. It also
calls tools and connections. Keeping both would give models two JavaScript
tools. How the removal is released is decided separately.

- **Removed.** `workflow()`, `eve/tools/workflow`, and
  `execution/dynamic-workflow/tool.ts`. An agent that imports it fails to
  compile with: `workflow() was removed. Set codeMode: true in agent.ts; programs call agents as tools.<name>({ message }).`
- **Survives, generalized.** The program step and the continuation security
  step move behind `eve__execute`. The agent interrupt becomes the interrupt for
  every waiting call kind.
- **Behavior differences for the migration notes:**
  - `agent/tools/workflow.ts` goes away, and `agent.ts` sets `codeMode: true`.
  - The program's input is `code`, not `js`.
  - Programs call `tools.<name>({ message })`, not `ctx.agent(name, { message })`.
  - The call holds the turn instead of running as a task.
  - Hidden agents need `tool: "deferred"`.
  - `maxSubagents` is gone. The limits are 128 agent calls and 1,024 calls.

## Rollout

### Spike first

One spike settles what the recovery design assumes, before [1/3]:

- A retried program step can read the nested calls its interrupted attempt
  published, with their outputs, the way `readInterruptedAttempt` reads a
  model step's.
- Nested call ids stay the same on a retry when calls ran concurrently. If
  `run` doesn't replay resolution order, ids need another source than start
  order.

### Pull requests

Stacked, following the #4400 shape.

| PR            | Scope                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [1/3] Runtime | `codeMode` on `defineAgent`; `eve__execute` and its description; the program step after the model step; nested resolution through the step catalog; inline runs, interrupts, and the continuation in session state; nested approval, sign-in, workflow, and agent dispatch; crash recovery; steering and cancellation; `owner` on nested calls; labels and client grouping; removal of `workflow()` |
| [2/3] Types   | Output-type notes on direct tools; output validation for program calls; OpenAPI output schemas; the build warning                                                                                                                                                                                                                                                                                   |
| [3/3] Tests   | Every new test, below                                                                                                                                                                                                                                                                                                                                                                               |

Docs and the changeset for the new tool go with [1/3]. [2/3] carries a
`patch`.

### Tests

- **Session test on the in-process host (#6080).** One session with code mode
  on drives programs through:
  - an inline tool, a deferred tool, and a connection tool in one program;
  - an approval mid-program, both approved and denied;
  - a batch of approvals opened together;
  - a sign-in mid-program;
  - a workflow tool that holds the turn;
  - parallel agents with `outputSchema`;
  - `search()` followed by a call in the same program;
  - each call limit hit;
  - a steering message while parked and while inline calls run;
  - compaction between programs.

  It asserts the cache invariants and that nested calls never reach history.

- **Replay.** After a resume, completed calls aren't re-invoked, events
  aren't re-emitted, and child ids are stable.
- **Crash recovery.** A program step interrupted after some nested calls
  settled and one started: the retry replays the settled calls, rejects the
  started one, runs the rest, and keeps every id.
- **E2E.**
  - Extend `agent-deferred-tools` with a code-mode agent. Its world suites run
    on the mock model, which must call `eve__execute`. They cover approval keyed
    to the nested entry, the workflow tool parking and resuming, an agent
    fan-out, and `t.calledTool` on nested calls.
  - Its real-model suite covers cache reads after programs.
  - Move the `workflow()` evals in `agent-subagents` and `agent-cancellation`
    to `eve__execute`, written fresh against the new surface.
- **New real-model evals**, written as process narratives:
  - Alice reconciles orders against payments and support tickets across two
    connections.
  - Bob reads an export with `read_file` and checks each row against a
    connection.
  - Alice sends a follow-up to each lead on a list through a tool that asks
    for approval, and Bob approves some and declines others.
  - A fan-out to parallel agents, combined with connection data.
  - An MCP server with untyped outputs.

### Measurements and ship gate

Run one task set in two arms, code mode off and code mode on, at a moderate
and a large tool count. Measure task success, model calls, input tokens, cache
read ratio, and latency.

- **Composition tasks.** Code mode must cut model calls and input tokens with
  no loss in success.
- **Single-call tasks.** No regression in success or latency.
- **Program-step overhead.** The latency the extra step adds to a short
  program, recorded per world.
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
- `concepts/built-in-tools`: an `eve__execute` section with the catalog tools,
  and the reserved-name list.
- `concepts/execution-model-and-durability`: program steps and how a program
  recovers from a crash.
- `concepts/sessions-runs-and-streaming`: nested calls and their `owner`.
- `tools/index`: why output schemas matter, and a nested call's `ctx.callId`
  as an idempotency key.
- `tools/human-in-the-loop`: approvals in programs.
- `tools/workflows`: remove the runtime-generated workflow tool section.
- `tools/tasks`: agent and task calls inside programs.
- `subagents/index`: `tool: "deferred"` for agents only programs should call.
- `connections/index`: connections in programs, and sign-in mid-program.
- `evals/assertions`: nested calls and `eve__execute`.
- `reference/typescript-api`: remove `eve/tools/workflow`.

Migration steps go in the changeset, not in `docs/`.

## Decisions and alternatives considered

| Decision                      | Chosen                                                                                            | Rejected                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enablement                    | `codeMode: true` on `defineAgent`, fixed per deployment, off by default until measured            | A sentinel file under `agent/tools/` (a tool file is the author's to rename, wrap, namespace, or return dynamically; none apply here, and each needs a rule); always on (unmeasured, and costs tokens for agents that never compose); a dynamic setting (flips `tools`) |
| Name                          | `eve__execute`, reserved by #4400                                                                 | A path-derived name (puts an author-chosen name into eve's listing and output-type notes); `execute` (an ordinary authored name since #4400); `codemode`                                                                                                                |
| Relation to the catalog tools | Added beside `eve__search`, `eve__tool`, and `eve__skill`                                         | Replacing `eve__tool` at ship (one-call JSON calls are cheaper and well trained; revisit with data); search only inside code (opencode)                                                                                                                                 |
| Dispatch                      | Every nested call resolves through the step catalog and runs on the direct-call path              | A workflow-tool program like `workflow()`, re-implementing approval, sign-in, and dispatch inside a workflow run (a second path for every job)                                                                                                                          |
| Execution                     | Its own program step after the model step saves; inline inside it; interrupt only to wait         | Inline in the model step (a crash re-asks the model, under a new call id, from a 20-call note); interrupt on every call (one durable step per call); a program that can't pause                                                                                         |
| Crash recovery                | Recorded calls replay; a started call rejects in the program; stable nested ids                   | Re-running the program (repeats side effects); leaving it to the model's interrupted-step note (too small for a loop)                                                                                                                                                   |
| Approval                      | Each nested call under its own policy and prompt                                                  | Approving the program as a whole (hides what each call does); skipping approval in code (what a hand-rolled runtime does)                                                                                                                                               |
| Names in code                 | Flat catalog names                                                                                | Nested owner paths such as `tools.crm.api.list_issues` (sketched in #4400; needs owner records and a second naming scheme)                                                                                                                                              |
| What code can call            | Whatever `eve__tool` accepts, minus turn-ending tools                                             | Per-tool `codemode` flags (opencode); pi's exposure enum; deferred entries only                                                                                                                                                                                         |
| Skills                        | Found by `search()`, loaded by the model with `eve__skill`                                        | Loading from a program (a skill instructs the model, not a program; neither pi nor opencode does it)                                                                                                                                                                    |
| Agents in code                | Awaited replies owned by the `eve__execute` call; `outputSchema` allowed; a new child per call    | Task receipts in programs; continuing a child by `taskId` at ship                                                                                                                                                                                                       |
| Nested calls on the stream    | The existing `owner: { callId }`                                                                  | A new `parentCallId` field (a protocol change the stream no longer needs)                                                                                                                                                                                               |
| Catalog presentation          | Existing listing plus one fixed clause; output types on direct tools; signatures from search      | Budgeted inline signatures (overrides `deferred`); catalog in the tool description (pi); a description that names `eve__search` (changes when a session gains it)                                                                                                       |
| Untyped outputs               | `Promise<unknown>`; build warning when code mode is on                                            | Requiring output schemas; `string` (pi)                                                                                                                                                                                                                                 |
| Input form                    | JSON `{ code }` at ship                                                                           | Lark grammar at ship (provider-specific declaration, history normalization, and unverified on AI Gateway); see open questions                                                                                                                                           |
| `workflow()`                  | Removed                                                                                           | Keeping a second JavaScript tool                                                                                                                                                                                                                                        |
| Network                       | None in programs                                                                                  | `fetch` (opencode has no SSRF guard or permission check)                                                                                                                                                                                                                |
| Limits                        | Fixed: 1,024 calls, 128 agent calls, plus compute, wall-clock, continuation, and result-size caps | One 256-call limit (too low for a two-call loop over 150 items); settings on `codeMode` at ship                                                                                                                                                                         |

## Open questions

- **One approval for a batch.** A loop over 150 sends under `always()` asks
  150 times. `once()` and policy functions cover many cases, but not "approve
  these 150 inputs together". Whether a batch gets one prompt, and how
  `once()` treats calls already waiting when the first is approved, is worth
  its own design.
- **Raw JavaScript input.** pi declares a Lark grammar for OpenAI models so
  the model writes source instead of a JSON-escaped string. Shipping it means
  a provider-specific declaration, and normalizing calls to `{ code }` in
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
- **Recovery from the stream is unproven.** The crash table assumes a retried
  program step can read its interrupted attempt's nested calls and outputs,
  and that nested ids survive a retry under concurrency. The spike tests
  both.
- **The program step's cost is unmeasured.** One extra durable step per
  program is assumed small next to a model call.
- **Parking cost.** Programs that park on every call get one program step per
  call. That is no worse than one model step per call, but it isn't free.
- **Continuation growth.** The ledger re-serializes every recorded result on
  each resume. At 1,024 calls, the 8 MiB cap leaves about 8 KiB per result.
  Both numbers are estimates to tune against real programs.
- **Time limits are estimates.** The 30 s compute and 5 min wall-clock limits
  are today's `workflow()` values, not measurements of programs that run
  inline calls. Programs that park often spend more of each resume's compute
  budget on replay.
