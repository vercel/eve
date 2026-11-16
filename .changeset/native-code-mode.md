---
"eve": minor
---

Add code mode: set `codeMode: true` on `defineAgent` and the model can call `eve__execute` to run a JavaScript program that chains, loops over, and combines its tool calls in one step, so intermediate results stay out of the conversation.

A program calls any tool the model can use as `await tools.<name>(input)` and finds deferred tools with `await search({ query })`. Each call goes through its own tool's approval, sign-in, and hooks, and a program waits durably on approvals, sign-ins, workflow tools, and agents. Tools with an `outputSchema` give programs a typed result; the build warns about authored tools without one when code mode is on, and OpenAPI connection tools derive their output type from the success response. Clients receive a program's calls with `owner: { callId }`, and `useEveAgent` tool parts carry `parentCallId`.

The `workflow()` tool and the `eve/tools/workflow` entry point are removed; code mode replaces them. An agent that still imports `eve/tools/workflow` fails to compile with a message that names the replacement. To migrate:

- Delete `agent/tools/workflow.ts` and set `codeMode: true` in `agent.ts`.
- Programs take `code` instead of `js`, and call agents as `tools.<name>({ message, outputSchema? })` instead of `ctx.agent(name, { message, outputSchema? })`.
- A program holds the turn and its result is the `eve__execute` tool result, instead of running as a task. A new message stops it.
- A program can't call an agent with `tool: false`. Set `tool: "deferred"` to keep an agent out of the model's tool list while programs call it.
- `maxSubagents` is gone. A program may call agents at most 128 times and make at most 1,024 calls.
- Agent calls from a program go through the agent-wide approval policy, like the model's own calls.
