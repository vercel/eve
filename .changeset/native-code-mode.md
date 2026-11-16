---
"eve": minor
---

Add code mode: set `codeMode: true` on `defineAgent` and the model can call `eve__execute` to run a JavaScript program that chains, loops over, and combines its tool calls in one step, so intermediate results stay out of the conversation.

A program calls any tool the model can use as `await tools.<name>(input)` and finds deferred tools with `await search({ query })`. Each call goes through its own tool's approval, sign-in, and hooks, and a program waits durably on approvals, sign-ins, workflow tools, and agents. Tools with an `outputSchema` give programs a typed result; the build warns about authored tools without one when code mode is on, and OpenAPI connection tools derive their output type from the success response. Clients receive a program's calls with `owner: { callId }`, and `useEveAgent` tool parts carry `parentCallId`.

The `workflow()` tool from `eve/tools/workflow` now runs the same kind of program in the background, as a task. The authored file is unchanged, but what the model writes is not:

- The tool's input is `{ code }` instead of `{ js }`.
- A program calls agents as `tools.<name>({ message, outputSchema? })` instead of `ctx.agent(name, { message, outputSchema? })`.
- The task result is `{ result, logs?, calls }` instead of the bare return value, and a program that throws fails its task with the error, the line that threw, and its console output.
- `maxSubagents` defaults to 128 instead of 100.
- A failed call throws a `ToolError` instead of a `WorkflowProgramAgentError`, and a call over the limit reports `EXECUTE_AGENT_LIMIT_REACHED` instead of `WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED`.

Update instructions, tool stubs, and evals that spell out the old program shape, such as `t.calledTool("workflow", { input: { js } })`. A `workflow()` program in flight during the upgrade fails and must be started again.
