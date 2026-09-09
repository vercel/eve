---
title: "Code Mode"
description: "Let the model orchestrate tools and subagents from one JavaScript program that runs as a durable workflow."
url: /tools/code-mode
---

Code mode adds a framework tool named `code_mode` to the root agent. The model
writes a JavaScript program that calls `tools.<name>(input)`, and eve runs that
program as a durable workflow: every nested tool or subagent call is its own
step, results flow back into the program, and a crash or restart resumes at the
pending call instead of re-running earlier ones. Use it when a task needs
fan-out, loops, retries, or reduction over intermediate results that would
otherwise take many model turns.

Code mode is experimental and opt-in. The configuration and behavior on this
page can change in any release.

## Enable code mode

Set `experimental.codeMode: true` in `agent.ts`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.5",
  experimental: { codeMode: true },
});
```

`code_mode` is available only in the root session. Child sessions started by
declared subagents or the built-in `agent` tool do not receive it.

`code_mode` replaces the former `Workflow` tool. If your project still exports
`experimental_workflow()` from `eve/tools/workflow`, remove that file and enable
code mode in `agent.ts`. Authored [workflow tools](./workflows) are unaffected.

## What the model sees

With code mode enabled, the model's tool list contains:

- Every built-in, authored, and subagent tool that it would see without code
  mode. These stay directly callable.
- `code_mode`, whose description lists the names of every tool a program can
  call and explains the discovery helpers below.

Tools supplied by dynamic providers, including connection tools found through
`connection_search`, are not advertised directly when they are eligible for
programs. The model reaches them through `code_mode`. Approval-gated dynamic
tools stay direct so their approval flow is unchanged.

The model is instructed to prefer direct calls for single operations and
programs for work that chains, loops over, or reduces several calls.

## Which tools a program can call

A program can call a tool when all of the following hold:

- The tool has an executor and is not a framework control such as
  `connection_search`, `ask_question`, or a task-control action.
- The tool has no approval policy, or its policy is `never()`.
- The tool is not an authored workflow tool.
- The tool is not an ordinary `execution: "background"` tool. Subagent tools are
  the exception: inside a program they run to completion and return the child's
  final result instead of a task receipt.

Everything else remains callable only directly. Discovery marks those tools with
`requiresDirectCall: true`.

| Tool                                                | Direct call | Inside a program    |
| --------------------------------------------------- | ----------- | ------------------- |
| Built-in tools such as `bash`, `read_file`, `todo`  | yes         | yes                 |
| Authored `defineTool` tools without approval        | yes         | yes                 |
| Declared subagents and the built-in `agent` tool    | yes         | yes, awaited result |
| Discovered connection tools without approval        | no          | yes                 |
| Any tool with an approval policy other than `never` | yes         | no                  |
| Authored workflow tools (`defineWorkflowTool`)      | yes         | no                  |
| Ordinary background tools                           | yes         | no                  |
| `connection_search`, `ask_question`, task controls  | yes         | no                  |

When names overlap, step-scoped dynamic definitions override turn-scoped,
session-scoped, and static definitions, in that order.

## Discover tools from a program

Two helpers are available inside every program. Neither runs a tool or bypasses
an approval policy.

`tools.search_tools({ query })` returns `{ name, description, requiresDirectCall }`
for each matching tool. `query` is a case-insensitive keyword search over names
and descriptions using the same ranking as `connection_search`: each partial
match scores 3 in a tool name and 1 in a description, and higher totals rank
first. Ties keep catalog order. Queries split on whitespace, underscores,
hyphens, periods, and slashes, and ignore single-character tokens. Omit `query`
to list the program's whole catalog.

`tools.describe_tools({ names })` returns the same summary plus `inputSchema` for
each requested name, or `{ name, error: "unknown tool" }` for names that are not
in the catalog.

The catalog is fixed when the program is dispatched. It excludes connection
tools that have not been discovered yet, so an empty search result does not
mean the connection lacks that API. Call `connection_search` directly with the
connection name and relevant keywords, then start a new program to use the
discovered tools.

## How a program runs

`code_mode` is a workflow tool. eve starts one durable workflow run per program:

1. The program runs in an isolated JavaScript sandbox with a stub for every
   callable tool. Calling a stub parks the program and hands the call to the
   workflow body; the sandbox itself never performs a side effect.
2. Each parked call runs as its own workflow step against the turn's tool set.
   Calls issued together with `Promise.all` are parked together and settle
   concurrently.
3. When the batch settles, eve resumes the program with the recorded results
   and it continues until the next call or until it returns.
4. The program's return value becomes the `code_mode` tool result the model sees.

Resuming re-executes the program's source from the beginning with every earlier
call answered from the recorded ledger. Tool side effects do not repeat, but the
JavaScript between calls does, so keep that code deterministic: derive control
flow from tool results and inputs, not from `Date.now()`, `Math.random()`, or
other values that differ between runs.

A tool or subagent failure rejects the corresponding JavaScript call, so
programs can use `try`/`catch` or `Promise.allSettled`. Parking a call does not
run the program's `catch` or `finally` handlers; they run only after the call
settles with a result or a failure.

Cancelling the turn cancels the workflow run.

## Subagents inside a program

Calling a declared subagent or the built-in `agent` tool from a program awaits
the child's final response. Pass `agentId` to continue or steer a child started
earlier in the same program, the same way the direct tool does.

Each program can invoke at most 100 subagents. Sequential calls, parallel calls,
retries, and continuations of an existing child all count. Excess calls reject
with `CODE_MODE_SUBAGENT_LIMIT_REACHED` before a child starts, and the program
can catch that rejection. Ordinary tool calls do not consume this budget.

## Authorization inside a program

Nested tool calls authorize the same way calls inside an authored workflow tool
do. When a tool requires sign-in, eve emits `authorization.required` on the
parent session, waits durably for the matching callback, emits
`authorization.completed`, and retries only that call. Earlier completed calls
keep their results, and the program does not observe the pause.

## Session state across calls

Nested calls run against a snapshot of the parent session taken when the
program was dispatched. They see the conversation history as of that model step
and the tool catalog that step advertised.

Context updates that tools make, such as todo lists and file-read records, are
carried forward to later calls in the same program and back to the parent
session when the program finishes. Updates from completed calls survive a later
program failure or cancellation. Tool side effects that already happened are not
rolled back.

Concurrent writes to the same state field from calls in one batch fail the
later call in program order with `CODE_MODE_STATE_CONFLICT`; the program can
catch it. If the merge back into the parent session conflicts with newer parent
state, the `code_mode` call is reported as failed with the same code even though
the program itself completed.

## Errors the model sees

Invalid JavaScript, uncaught program errors, uncaught nested-tool errors, and
sandbox limit failures (source size, bridge request count, or result
serialization) return to the model as the `code_mode` tool result without
retrying the unchanged program. Sandbox infrastructure failures keep the normal
workflow step retry policy.

## Current state and limitations

- The `experimental.codeMode` setting is a boolean. The 100-subagent budget per
  program is fixed.
- The program source and every recorded result travel with each resume, so
  programs that accumulate large intermediate results grow the per-step payload.
  Reduce results inside the program instead of returning raw data.
- Each nested call rebuilds the turn's tool set from the dispatched snapshot.
  Programs with many small sequential calls pay that cost per call.
- Programs run in the root session only.
- Dynamic tools with an approval policy other than `never()` remain direct-only;
  programs cannot wait on a human approval.

## Related

- [Workflows as tools](./workflows) for authoring durable tools yourself, including
  `ctx.agent` and `ctx.ask`.
- [Subagents](../subagents) for how declared subagents and the built-in `agent`
  tool behave outside a program.
- [Built-in tools](../concepts/built-in-tools) for the tools programs can call
  by default.
- [Agent configuration](../agent-config#other-defineagent-fields) for the
  `experimental` field.
