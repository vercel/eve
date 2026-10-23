---
issue: "TBD (no matching issue found)"
status: proposed
last_updated: "2026-09-29"
---

# Code mode

Code mode lets the model write a program that calls tools, instead of calling one tool per model
turn. eve already runs model-written programs through `workflow()`, but they can only call
`ctx.agent`. This document proposes a `run_js` tool that supersedes `workflow()` and can call the
agent's tools, including connection tools.

- `run_js` runs on the sandbox and parking bridge that `workflow()` uses today, keeps `ctx.agent`,
  and adds `ctx.tools`, `ctx.search`, and `ctx.describe`. `workflow()` is removed, and
  `connection_search` is removed once the discovery benchmark confirms in-program search.
- `codemode: true` makes a tool callable only from `run_js` programs. Authored tools default to
  `false` and connection tools to `true`; no tool is callable both ways.
- Nested calls go through the ordinary harness tool path, so approvals, sign-in, validation, and
  events behave as they do for direct calls. Replay is per batch of nested calls, as it is per model
  step for direct calls.
- The model's tool list and the `run_js` description stay fixed for the session, so discovery never
  invalidates the prompt cache.

The evidence and the comparison of existing code-mode implementations behind these decisions are in
the code mode research report. The plans in [#3926](https://github.com/vercel/eve/pull/3926) are
related: the MCP capabilities channel publishes eve agents' tools over MCP, client-side capability
discovery picks how a model finds connection tools, and remote agents move onto MCP tasks. Code mode
builds on all three for connection tools and connection agents.

## Premises

Code mode is argued for on seven claims. Each holds on some tasks and fails on others.

| Claim                               | Holds when                                        | Fails when                                                                                             |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Fewer turns, lower latency and cost | Several dependent calls; fan-out; expensive turns | One-call tasks; programs that wrap a single call; long generated programs; steps that need judgment    |
| Smaller context                     | Large intermediate results with a known reduction | Exploratory questions; answers that must cite data; programs that return everything; silent truncation |
| Affordable large catalogs           | Hundreds to thousands of tools                    | Catalogs of 128 tools or fewer; guessed names; discovery that costs turns                              |
| More reliable than structured calls | Recent frontier models; typed results             | Older or smaller models; unusual runtimes; untyped results                                             |
| Exact data passing                  | Correct programs; lossless serialization          | Wrong programs; values changed in transit; models skipping the tools                                   |
| Data kept from the model            | Tight bindings; no network; per-call approval     | Weak sandboxes; prompt injection with a way out; whole-program approval                                |
| Reusable state                      | Not demonstrated                                  | Restarts; stateless hosted runtimes                                                                    |

The measurements behind the table:

| Finding                                 | Measurement                                                                                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| It pays off on deep tasks               | A synthetic incident task (two result pages, five services, four rollbacks with one retry, three notifications): model steps 13 → 2, input tokens −82.9%, wall time −51.8%, 5/5 correct in both arms                                                      |
| It loses on shallow tasks               | A task that reduced to one known SQL call: +56% wall time and +129% cost across 20 paired attempts, with 153% more output tokens                                                                                                                          |
| The harness decides the direction       | The same incident task without durable steps took 7 direct steps; code mode cut them to 2 but ran 35.4% slower, because output rose from 1,027 to 2,607 tokens                                                                                            |
| Models do not choose between routes     | With the same tools offered directly and through code mode, the model called code mode zero times and paid for both catalogs                                                                                                                              |
| Program shape varies                    | 51.2% of programs wrapped a single call, and open-ended prompts produced 4–8 programs per answer. One program per answer took an explicit instruction                                                                                                     |
| Untyped results fail silently           | With results typed `unknown`, programs treated `{ ok: false, retryable: true }` as success and passed 3/5; with output schemas, 5/5                                                                                                                       |
| Searching in a model turn is slow       | Searching for tools in one model turn and calling them in the next added 127% wall time and 73.8% cost on one task                                                                                                                                        |
| Models guess names before searching     | With search-only discovery, 9/20 attempts were accepted against 20/20 for direct calls. In all 11 differing pairs, the model called a guessed name first                                                                                                  |
| The replay unit matters                 | A prototype that ran a whole program inside one step repeated its writes on redelivery: exactly-once in 2/5 runs, against 5/5 for direct calls                                                                                                            |
| Calling tools beats delegating the task | A prototype orchestrator that called three specialist agents' tools directly, instead of delegating to them as remote subagents, matched their pass rate on 24 cases run twice (94% each), at 15 s median latency against 28 s and 25k tokens against 92k |
| The benefit depends on the model        | 11 of 14 models matched or beat structured calls, but GPT-4.1 fell from 98.1% to 40.4% on chained calls ([Patel et al., 2026](https://arxiv.org/abs/2608.06370))                                                                                          |

Code mode is therefore worth using for a task when all of these hold:

1. several calls take inputs from earlier results;
2. every tool the task needs is reachable from the program;
3. no step needs the model to read a result before continuing;
4. the reduction from results to an answer can be written in advance;
5. the results the program branches on have declared types;
6. the task is read-only, or its writes tolerate the same replay rules as direct calls;
7. the model has been evaluated on this runtime.

The design keeps direct calls wherever these conditions fail, and the evaluation plan tests the ones
the evidence does not settle.

## Current state

- **Programs.** `workflow()` from `eve/tools/workflow`, enabled by `agent/tools/workflow.ts`, takes
  `{ js }` and runs it in the vendored `@ai-sdk/code-mode` QuickJS sandbox as a side-effect-free
  step. It is a workflow tool with a `task` entry point, so the program's value reaches the model
  later, in a `task.result` message. Its only host binding is `ctx.agent`, capped by `maxSubagents`.
  Each call parks the program as an interrupt; the owning durable workflow runs the pending batch,
  then resumes the program from its signed continuation. A failed resolution reaches the program as
  a thrown error that carries only a message.
- **Direct tools.** A `defineTool` call runs inline in the step that holds the model call. A
  completed step replays from its record; a step interrupted mid-execution re-runs, tool calls
  included. Approval requests carry the exact tool input.
- **Connections.** `connection_search` stores its results in durable session context, and matched
  tools become callable in the model's next response, so every discovery costs a turn. Each hit adds
  tools to the model's tool list. Tool definitions come first in the cached prompt, and changing
  them invalidates the whole cache ([prompt
  caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Search results
  carry each tool's input and output schema, which the tool definition then repeats. MCP tool names
  are fetched lazily on first use. OpenAPI connections filter by `operationId` through `operations`.
  Dynamic connections resolve from `session.started` or `turn.started`.
- **Projections.** `toModelOutput` controls what the model sees of a result. MCP results are
  projected to their content blocks, without `_meta` or `structuredContent`, and failures get a
  leading "Tool call failed:" marker.
- **Events.** `action.started` has no parent field, and action spans are parented to the
  model-attempt span.

## Authoring API

### The `run_js` tool

```ts title="agent/tools/run_js.ts"
import { runJs } from "eve/tools/run_js";

export default runJs({ maxSubagents: 20 });
```

`run_js` supersedes `workflow()`. It keeps the `{ js }` input, `ctx.agent`, and `maxSubagents`, and
adds `ctx.tools`, `ctx.search`, and `ctx.describe`. `workflow()` and `eve/tools/workflow` are
removed in the same release, so the model never sees two JavaScript tools. Authored durable tools,
defined with `defineWorkflowTool`, are unaffected.

The name follows eve's verb-and-noun tool names and states the language, so it cannot be mistaken
for `bash`. "Code mode" stays the name of the feature.

An agent has `run_js` when it defines `agent/tools/run_js.ts` or any connection under
`agent/connections/`; an agent with connections and no file gets the defaults. There is no separate
flag, and an agent with neither is unchanged. The documentation lists the model families that pass
the code-mode eval suite.

Like `workflow()`, `run_js` is a workflow tool, and its `"use workflow"` body owns the program's
nested calls. It uses the `execute` entry point instead of `task`. A call blocks the turn until the
workflow settles, and the program's value is the tool result rather than a later `task.result`
message, because the model's next step depends on it. While the workflow waits on a nested call, the
turn parks without holding compute.

### Code mode tools

```ts title="agent/tools/get_order.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { orders, orderSchema } from "../lib/orders";

export default defineTool({
  description: "Look up an order by id.",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: orderSchema,
  codemode: true,
  async execute({ id }) {
    return orders.get(id);
  },
});
```

A tool with `codemode: true`, a code mode tool, leaves the model's tool list and is callable only as
`ctx.tools.<name>(input)` from `run_js` programs. `false`, the default for authored tools, keeps it
a direct model tool. No setting makes a tool callable both ways. `codemode: true` is a definition
error when the agent has no `run_js` tool, when the tool defines `toModelOutput`, or when the tool
cannot run outside a turn. That last check is the `invocable` predicate the MCP capabilities channel
uses, which excludes framework tools that depend on a turn (`bash`, `load_skill`), workflow tools,
background tools, and tools with special handling. Tools without `execute`, such as
provider-executed tools, are excluded too.

### Connections

```ts title="agent/connections/linear.ts"
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description: "Linear issues, projects, and comments.",
  codemode: { create_issue: false },
});
```

Connection tools default to `codemode: true`. On a connection, `codemode` is either a boolean for
every tool the connection exposes after its filter (`tools.allow` or `tools.block` for MCP,
`operations` for OpenAPI), or an object of per-tool exceptions to that default, keyed by MCP tool
name or OpenAPI `operationId`. MCP tool names are known only once the connection lists its tools, so
an exception for a tool the server does not publish is a runtime warning, logged when the
connection's tools are first fetched.

A connection tool with `codemode: false` is reached through whichever pattern the client-side
discovery plan selects: preloaded into the model's tool list at session start
([#3745](https://github.com/vercel/eve/issues/3745)), or called through one fixed dispatch tool.
Either way the tool list never changes during a session. Only static connections and
`session.started` connections can set `codemode: false`; `turn.started` connections are code-mode
only.

Inside a program, connection tools go through the same connection client that the discovery plan
proposes for authored tools, `ctx.connection(name)`. Programs, authored tools, and userland patterns
therefore share one path for auth, principal forwarding, the capability session, and
`input_required`. A program's connection calls use the caller session's capability session, so a
program and direct calls share one provider sandbox.

## Design decisions

The code mode research report compares existing implementations on 22 dimensions. eve's choice on
each follows.

### Setup

- **Tool registration.** No new registry. Authored tools come from `agent/tools/` and extensions,
  and connection tools from `agent/connections/`, with names derived from paths and server tool
  names. eve's registries already carry schemas, approval policies, and authorization.
- **Calling routes.** Each tool is either a direct model tool or a code mode tool, never both, set
  by `codemode`. With both routes available, the model never picked code mode, and only exposure
  enforces how a tool is called.
- **Initial tool context.** The `run_js` description holds the runtime rules, signatures of code
  mode authored tools up to a token budget, names for the rest, and static connections by name and
  description. It is fixed for the session. Search-only discovery led models to guess names (9/20),
  while selection accuracy barely changes up to 128 tools, so listing signatures is affordable.
- **Definition format.** TypeScript declarations rendered from input and output schemas, keeping
  constraints such as `minimum`, `maximum`, and `pattern` as comments. When a maximum was dropped,
  the model sent `30` where the maximum was `25`.

### Discovery

- **Discovery interface.** `ctx.search(query)` and `ctx.describe(names)` inside the program, over
  code mode tools and connection tools. Search as its own model turn cost 127% more wall time on one
  task, and `connection_search` changes the tool list on every hit. In-program search joins the
  client-side discovery benchmark as a third arm, next to materialized tools (`connection_search`)
  and dispatch (`discover` and `tool_call`), on the same cases and with prompt-cache hit rate
  reported. `connection_search` is removed if in-program search matches or beats both.
- **Search ranking.** Lexical matching over tool names, descriptions, and connection descriptions,
  reusing the existing connection matching. A search with no match says so, and calling an unknown
  name throws with the closest names, since a missed synonym otherwise looks like a missing tool.
  Discovery misses are measured separately from execution errors (H3).
- **Search timing.** A tool found by `ctx.search` is callable in the same program. A benchmark arm
  passed with two searches inside one program.

### Execution

- **Generated language.** A JavaScript async function body in `{ js }`, as `workflow()` takes today.
- **Execution runtime.** The vendored `@ai-sdk/code-mode` QuickJS sandbox, run as a
  side-effect-free step. It has no network, imports, filesystem, or process; host capabilities are
  only `ctx.agent` and `ctx.tools`. The description lists every difference from standard JavaScript,
  since each unlisted difference is a way for a program to fail.
- **Agents in programs.** `ctx.agent(name)` reaches local subagents today. Once remote agents move
  onto MCP tasks, it also reaches connection agents, including ones marked `agent: "hidden"`. The
  `run_js` workflow waits on the agent's MCP task and resolves to its reply, and the call counts
  toward `maxSubagents`. Task receipts stay for agents the model calls directly.
- **Input validation and transport.** Every nested call is validated against the tool's input
  schema, as a direct call is. Values that are not JSON, such as `Date`, `BigInt`, and functions,
  are rejected with an error instead of being converted, because a silent conversion produces a
  wrong call that nothing reports.
- **Authorization and approvals.** Every nested call goes through approval policies, connection
  authorization, and sign-in. A call that needs approval uses the existing approval request, which
  carries the exact input, and the turn parks as it does for a direct call. A declined call throws
  in the program. The program resumes from its signed continuation, so it cannot change a call's
  input after making it. When a connection call returns MCP `input_required`, the `run_js` workflow
  parks the program on that call and emits `input.requested`, as the capabilities channel plan
  proposes for direct connection calls. It then retries with the person's `inputResponses`.
  `requestState` stays in the call's durable record, where neither the program nor the model sees
  it.
- **Parallelism and cancellation.** Calls the program makes together, for example under
  `Promise.all`, park as one batch and resolve concurrently, within the in-flight limit. This covers
  tool calls and agent calls alike, as parallel tool calls from one model step already run together.
  Calls the program awaits one after another arrive in separate batches and stay sequential. Each
  call's id is assigned when the program makes it, and results are recorded by that id, so replay
  does not depend on completion order. Cancelling the turn aborts the in-flight calls, and calls a
  program leaves un-awaited are cancelled when it returns.
- **Execution budgets.** The existing bridge request limit (256) counts tool calls as well as agent
  calls, and `maxSubagents` still counts only agent calls. The time budget covers sandbox execution;
  waiting on a call parks instead of counting. Every remote connection call has a timeout. Recorded
  results count against the continuation budget (32 MiB by default, with at most 4 MiB per result),
  because the program resumes from a continuation that carries every earlier result. Before a result
  is recorded, it is checked against the remaining budget. A result that does not fit resolves the
  call as failed, and the failure is what is recorded, so replay never runs the call again. The
  error says that the call completed, that its result was not kept, and how many bytes it needed,
  and suggests requesting less or returning a handle. The `run_js` description states both budgets.
  In probes, calls kept running after a reported timeout, so a budget must stop calls, not only the
  program.
- **State and context lifetime.** A fresh context per program, with no state carried across
  programs. Within one program, progress survives restarts through the signed continuation. No
  benefit from reusable state has been measured.

### Output

- **Return-type information.** A declared `outputSchema` becomes the result type, and an authored
  tool without one returns `unknown`. An MCP tool with `outputSchema` returns its
  `structuredContent`; without one, it returns `{ content }`, the content blocks the model
  projection shows. A connection tool whose provider projects its result, such as an eve tool with
  `toModelOutput`, returns only `{ content }`, so a program cannot return data the provider kept
  from models. OpenAPI results use the documented response schema when there is one, and `unknown`
  otherwise. Untyped results passed 3/5 and typed ones 5/5.
- **Output validation.** Results are validated when a schema exists, and a failure throws with the
  field, the constraint, and a preview. There is no raw escape hatch; a tool that cannot promise a
  shape omits `outputSchema`. In probes, a declared string arrived as `123` and a program skipped a
  refund without any error.
- **Who sees nested results.** Keeping data from the model means keeping it out of the model's
  context, not out of the session. Nested calls are ordinary actions: hooks and channels receive
  `action.started` and `action.result` with full output, as they do when the same tool is called
  directly, and trace content follows the channel's audience policy for each nested call. Code mode
  therefore changes how many events a turn produces, not who can see a tool's output. Built-in
  channels group nested actions under their `run_js` action by `parentCallId`, as one item with
  progress and a call count; nested approvals still render individually, since a person answers
  them. Suppressing nested events instead would break approvals, evals, and tracing.
- **Output delivered to the model.** The program's JSON return value, up to a size cap, and a
  truncated result says that it was truncated. Tools with `toModelOutput` cannot be code mode tools,
  since a program could return the raw result and bypass the projection.

### Recovery

- **Tool-error delivery.** A failed call always throws in the program, with the tool error's name
  and message. An MCP result with `isError: true` throws with its text, and a declined approval
  throws. An error returned as a value can be read as success.
- **Repair policy.** Fences and function wrappers are normalized deterministically. Failures return
  typed diagnostics: unknown tools with the closest names, invalid arguments with their issues, and
  reference errors with the available globals. Nothing is retried automatically. A failed program
  costs a full turn, so its diagnostic has to be enough to fix it in one.
- **Continuation.** The program resumes from its signed continuation with recorded resolutions, as
  `workflow()` does today, across restarts. After a program fails, the model writes a new one.
- **Repeated effects and compensation.** Nested calls get the same guarantee as direct calls. A
  completed call is recorded before the program resumes, and replay returns the record, so the
  replay unit is one batch rather than the whole program. A call interrupted mid-execution re-runs,
  so a non-idempotent tool needs the same idempotency or approval it needs as a direct call. A
  connection call retried after `input_required` also re-runs on the provider, which stores a
  sign-in's grant rather than the call. eve provides no compensation. A whole-program replay unit
  repeated writes in 3 of 5 runs.

### Operations

- **Tracing and attribution.** Action events gain `parentCallId`, which is the `run_js` call id for
  a nested call. The nested action span is a child of the `run_js` action span, and usage is
  attributed per call.

## Migration

`run_js` replaces `workflow()` in one release. `connection_search` is removed after the discovery
benchmark.

- **`workflow()`.** Agents rename `agent/tools/workflow.ts` to `agent/tools/run_js.ts` and export
  `runJs()` with the same options. Programs that call `ctx.agent` keep working, and their value now
  arrives as the tool result instead of a `task.result` message. A file that still imports
  `eve/tools/workflow` fails the build with an error that names `runJs()`. The `agent-subagents` and
  `agent-cancellation` fixtures move to `run_js`.
- **`connection_search`.** If in-program search wins the benchmark, it and the
  `<connection>__<tool>` model tools are removed. The `agent-workflow-tools` and
  `agent-openapi-swagger` fixtures and their connection evals move to `ctx.search` and `ctx.tools`.

The affected docs are `concepts/built-in-tools`, `connections/overview`, `connections/mcp`,
`guides/dynamic-capabilities`, and `tools/workflows`, whose runtime-generated workflow section
becomes a code mode page.

## Verification

A unit test over the rendered model request checks that the tool list and the `run_js` description
do not change when a program finds a connection tool or a `turn.started` connection resolves. Unit
tests also cover `codemode` defaults and definition errors, signature rendering, non-JSON input
rejection, output validation, and error mapping.

Scenario tests extend the existing program-step coverage. A nested tool call parks and resumes. A
process killed after a nested call completes resumes without re-running it. A batch of calls under
`Promise.all` resolves concurrently, and replay maps each result to its call regardless of
completion order. A result that exceeds the continuation budget fails the call once, and replay does
not run it again. A nested call that needs approval is approved in one run and declined in another.
A nested connection call that returns `input_required` parks the program and retries with the
answer.

Fixture evals cover a deep composition task and a single-call control, a connection tool found with
`ctx.search` and called in the same program, sign-in in the middle of a program, an MCP tool without
`outputSchema`, a program that fans out to subagents and combines their replies with tool results,
cancelling a turn while subagents run inside `run_js`, and one fixture agent calling another's tools
from a program through an MCP connection.

## Evaluation plan

| ID  | Question                                                   | Test                                                                                                                                                   | Decision rule                                                                                                           |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| H1  | Do gains require several dependent calls?                  | Task-shape suite with a single-call control; k ≥ 20                                                                                                    | Revise the conditions unless code mode loses on the control and wins on deep tasks                                      |
| H2  | Which results need declared types?                         | The same tasks with no output schemas, schemas only on results the program branches on, and schemas everywhere                                         | Require types only where their absence measurably lowers correctness                                                    |
| H3  | Which discovery pattern should eve use?                    | The client-side discovery benchmark with a third arm: materialized tools, dispatch, and in-program search, on the same cases, then at a larger catalog | Remove `connection_search` if in-program search matches or beats both on pass rate, latency, tokens, and cache hit rate |
| H4  | Does per-batch replay prevent duplicate writes?            | Kill the process mid-program on a task with writes                                                                                                     | Zero duplicates of completed calls at k ≥ 20                                                                            |
| H5  | Does approval inside a program work end to end?            | A refund that needs approval: accept, decline, and replay                                                                                              | No write before approval, and none repeated after                                                                       |
| H6  | Does the benefit hold across eve's model providers?        | The same suite across providers                                                                                                                        | The documented model-family list                                                                                        |
| H7  | Does hiding intermediate results hurt exploratory answers? | Real-prompt suite with expected answers                                                                                                                | Keep exploratory tools direct if quality drops                                                                          |
| H8  | Could a tool usefully be callable both ways?               | Exclusive exposure against both, on fitting and non-fitting tasks                                                                                      | Allow both only if the model picks correctly at an agreed rate                                                          |
| H9  | Does the tool name matter?                                 | `run_js` against `execute` on the same suite, with `bash` present                                                                                      | Keep `run_js` unless `execute` lowers wrong-tool calls or syntax errors                                                 |
| H10 | How does resume cost grow with program length?             | Programs of 1, 10, 50, and 200 calls, sequential and batched; wall time, workflow steps, and stored bytes                                              | Store continuation deltas instead of whole continuations if storage or latency grows faster than the number of calls    |

Every eval of an agent with code mode tools reports programs per answer and the share of single-call
programs, alongside success, tokens, cost, and latency.

## Evidence limits

- Most local runs are n = 1 to k = 5.
- Cache hit rates were not measured; the cache argument rests on provider documentation.

## Open questions

- Whether eve enforces the model-family list or only documents it.
- Whether `run_js` takes raw JavaScript through grammar-constrained tools where the provider
  supports them.
- Whether console output reaches the model when a program fails.
