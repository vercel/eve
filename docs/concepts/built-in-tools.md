---
title: "Built-in Tools"
description: "The default and opt-in tools eve provides, including code mode, glob, grep, and sleep."
---

eve provides a default tool set for every agent and additional tools you can add with one file. Each default occupies the same `agent/tools/<name>.ts` slot you would author yourself, so an authored definition replaces it and `disableTool()` removes it. Use this page to review what the model can call, opt into more capabilities, or override and disable defaults. For custom tools, see [Tools](../tools).

## Default tools

Default tools require no imports. The exact set depends on the agent and session. `agent` is available only in the root session; `load_skill` and `connection_search` appear only when the agent declares the corresponding resources; `ask_question` requires a session that can request user input; and `web_search` requires a supported model provider. The harness advertises only the tools available to the current session.

The default shell and file tools (`bash`, `read_file`, and `write_file`) run in the app and proxy their work into the agent's [sandbox](../sandbox). The table shows where each tool's effect lands.

| Tool                | Does                                                                                                                                                                                                                | Where it runs |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `bash`              | Run a shell command.                                                                                                                                                                                                | Sandbox       |
| `read_file`         | Read a text file with line-numbered output (enables read-before-write).                                                                                                                                             | Sandbox FS    |
| `write_file`        | Write a complete file; enforces read-before-write and stale-read detection.                                                                                                                                         | Sandbox FS    |
| `web_fetch`         | Fetch a URL.                                                                                                                                                                                                        | App runtime   |
| `web_search`        | Search the web (provider-managed; resolved from the model provider).                                                                                                                                                | Provider      |
| `todo`              | Maintain a durable per-session todo list.                                                                                                                                                                           | App runtime   |
| `ask_question`      | Ask the user a clarifying question or a choice mid-turn and park until they answer. No `execute`; the model calls it with `{ prompt, options?, allowFreeform? }`. See [Human-in-the-loop](/docs/human-in-the-loop). | App runtime   |
| `agent`             | From the root session, delegate a subtask to a fresh copy of the root agent.                                                                                                                                        | App runtime   |
| `load_skill`        | Pull an on-demand [skill](../skills)'s instructions into the current turn. Present only when the agent declares skills.                                                                                             | App runtime   |
| `connection_search` | Discover tools across declared [connections](../connections); matched tools become directly callable. Present only when the agent declares connections.                                                             | App runtime   |

The model-facing file tools accept absolute paths and paths beginning with `$HOME/`. eve resolves `$HOME` against the sandbox before invoking non-shell file operations, so packaged skill references such as `$HOME/.agents/skills/<skill>/references/...` work consistently across `read_file`, `write_file`, and the opt-in `glob` and `grep` tools.

Notes:

- **`agent`** is available only in the root session. Its child uses the root's instructions, tools, connections, and sandbox, but starts with fresh conversation history and fresh [state](./state). The child does not receive `agent`; declared subagents do not receive the built-in `agent` either. See [Subagents](../subagents).
- **`load_skill`** only pulls instructions into context. It adds no new execution surface, because behavior still comes from the tools the agent already has.
- **`connection_search`** surfaces a connection's tools by their qualified name (e.g. `linear__list_issues`), which the model can then call directly. The model sees it only when the agent has connections.
- **`web_search`** has no local executor; the provider runs it. AI Gateway models use Exa by default. To use Parallel instead, export `webSearch({ provider: "parallel" })` from `agent/tools/web_search.ts`. Direct provider models continue to use their native search implementation. To supply your own implementation, override it with `defineTool()`.
- **`web_fetch`** follows up to ten redirects, rechecking every destination for SSRF safety. Non-success HTTP responses return a plain-text failure result with the response body when available instead of failing the tool call.

Review these default tools before production use. Disable, wrap, restrict, or require approval for any tool that can access the filesystem, network, shell, or sensitive data.

## Add framework-provided tools

Some framework-provided tools stay out of the default set. Add the corresponding file when your agent needs one:

| Tool    | Definition to export             | Purpose                                    |
| ------- | -------------------------------- | ------------------------------------------ |
| `glob`  | `glob` from `eve/tools/glob`     | Find sandbox files by glob pattern.        |
| `grep`  | `grep` from `eve/tools/grep`     | Search sandbox file contents by regex.     |
| `sleep` | `sleep()` from `eve/tools/sleep` | Pause and durably resume the current turn. |

For example, add file discovery and content search with two files:

```ts title="agent/tools/glob.ts"
export { glob as default } from "eve/tools/glob";
```

```ts title="agent/tools/grep.ts"
export { grep as default } from "eve/tools/grep";
```

The filename supplies the model-facing tool name. The tools run against the agent's sandbox and use the same schemas, results, and error behavior as eve's framework implementations. Wrap either definition with `defineTool({ ...glob, description: "..." })` or `defineTool({ ...grep, description: "..." })` when you need to change its description or approval policy.

The sections below cover code mode and `sleep` in more detail.

## Override a default

Author a tool at the same slug and it takes over the built-in of that name. The file `agent/tools/write_file.ts` replaces the built-in `write_file` by existing:

```ts title="agent/tools/write_file.ts"
import { defineTool } from "eve/tools";
import { writeFile } from "eve/tools/write_file";

export default defineTool({
  ...writeFile, // keep the default description, schema, and executor
  async execute(input, ctx) {
    console.log("[write_file]", input.path);
    return writeFile.execute(input, ctx);
  },
});
```

Import each reusable definition from its own subpath:

| Definition  | Import                 | Registered by default |
| ----------- | ---------------------- | --------------------- |
| `bash`      | `eve/tools/bash`       | Yes                   |
| `readFile`  | `eve/tools/read_file`  | Yes                   |
| `writeFile` | `eve/tools/write_file` | Yes                   |
| `todo`      | `eve/tools/todo`       | Yes                   |
| `webFetch`  | `eve/tools/web_fetch`  | Yes                   |
| `loadSkill` | `eve/tools/load_skill` | Yes                   |
| `glob`      | `eve/tools/glob`       | No                    |
| `grep`      | `eve/tools/grep`       | No                    |

Importing a definition does not add it to an agent; export it from the corresponding `agent/tools/*.ts` file. Skip the spread and your replacement owns its own context. A fresh `defineTool` for `todo` does not inherit the default's durable state key.

Provider-managed web search has a dedicated configuration helper instead of an executable default:

```ts title="agent/tools/web_search.ts"
import { webSearch } from "eve/tools/web_search";

export default webSearch({ provider: "parallel" });
```

Set `provider` to `"exa"` or `"parallel"`. Without this file, AI Gateway models use Exa.

## Disable a default

Export a `disableTool()` sentinel from a file named after the tool's slug. The filename is what picks the default to remove:

```ts title="agent/tools/bash.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

Use `agent/tools/agent.ts` to remove the root-only `agent` delegation tool. The root session then receives no tool for delegating to a fresh copy of itself, and the model never sees that tool.

If the filename matches no known framework tool, resolution fails instead of silently doing nothing, so a typo surfaces at build time rather than removing the wrong tool.

## When to override, disable, or author a new tool

Three moves shape the harness. The right one depends on whether the model should keep the built-in capability.

- **Override** when you want the same capability with different behavior. Import its definition from the matching `eve/tools/<name>` subpath and wrap it (logging, an extra guard, or a different backend), and the model still sees a tool by that name. Spreading keeps the default's description, schema, and any framework state, such as the `todo` tool's durable state key. Drop the spread and your replacement owns its own context, losing that wiring.
- **Disable** when the model should not have the capability at all. A `disableTool()` sentinel removes the built-in, and the model never sees it. Reach for this to lock down `bash` or `web_fetch` in an agent that should not run shell commands or fetch arbitrary URLs.
- **Author a new tool** when you want a capability the harness does not ship. Give it a fresh slug under `agent/tools/` and it joins the built-ins instead of replacing one. See [Tools](../tools) for the authoring model.

## Experimental code mode

Set `experimental.codeMode` in `agent.ts` to add one `code_mode` orchestration tool alongside ordinary tools. The model writes a complete TypeScript program and calls typed inline tools as `tools.name(input)`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.6-terra",
  experimental: { codeMode: true },
});
```

The description includes a capped shortest-first signature listing. Generated code can call `await search({ query, limit, offset })` to find omitted tools and their exact signatures from the same request-scoped catalog.

Use code mode when later calls depend on earlier results, runtime results determine how many calls to make, or deterministic loops, filtering, validation, aggregation, and local reduction would otherwise require extra model turns. Every nested call must be read-only or safe to repeat under ordinary tool retry semantics. Prefer direct tools for one call, a small fixed set of independent calls, writes or irreversible effects, and work that needs approval, authorization, model judgment, or user interaction between calls.

The model should call `code_mode` at most once per response. One program can express dependent calls, cursor loops, retries, and parallel work:

```js
const pages = [];
let cursor = null;
do {
  const page = await tools.list_items({ cursor });
  pages.push(...page.items);
  cursor = page.nextCursor;
} while (cursor !== null);

const details = await Promise.all(pages.map((item) => tools.get_item({ id: item.id })));
return details;
```

### Admitted tools

Code mode automatically admits request-visible tools when they have an inline executor and executable input/output schemas. The rule applies after dynamic tool resolution, so request gates remain authoritative. With `experimental.tasks: true`, subagent and remote-agent tools may launch background tasks and return `{ taskId, status: "working" }` receipts; generated code cannot wait for their final results, and one program may launch at most eight. Eve stages those launches while the program runs and dispatches them only after it succeeds, so a failed, cancelled, or timed-out program starts no staged work. Foreground subagent calls, other background tools, tools with approval policies, provider-managed tools, `load_skill`, and `final_output` stay direct only. A nested tool that unexpectedly requires authorization exits with guidance to call it directly.

Generated programs receive the full value validated by `outputSchema`; direct calls continue to use any authored `toModelOutput` projection. Enable code mode only when those validated outputs are appropriate as model-authored program intermediates.

Code-mode programs are foreground work owned by the current turn. Background and task-control tools remain directly callable rather than entering the sandbox.

### Execution

`code_mode` is an ordinary synchronous AI SDK tool. First-party `@ai-sdk/code-mode` executes each program through its Run-backed isolated QuickJS runtime. Eve waits for every started nested host-tool call and returns the program's JSON value before the model continues.

Code mode follows the same retry semantics as other synchronous tools. If the enclosing Eve step is replayed, the program may run again. Tools with non-idempotent effects should use their normal idempotency and external-state checks; code mode does not add an exactly-once boundary.

### Sandbox boundary

Generated code runs in isolated QuickJS. It has no host `process`, imports, filesystem, or network unless those capabilities are explicitly exposed as tools. Host values cross the bridge as JSON. The program's final result must also be JSON-serializable.

## The opt-in `sleep` tool

The framework also ships a durable `sleep` tool, but does not add it to agents by default. Enable it with `agent/tools/sleep.ts`:

```ts
import { sleep } from "eve/tools/sleep";

export default sleep();
```

The model calls it with `{ seconds }` when it is useful to wait before checking progress or status again. The pause sleeps the durable turn workflow, so it does not hold an application runtime open, and the same turn continues automatically when the duration elapses. If one model response makes concurrent `sleep` calls, eve waits for the longest requested duration.

## What to read next

- [Tools](../tools): define your own tools, gate them on approval, and shape their output with `toModelOutput`
- [Dynamic capabilities](../guides/dynamic-capabilities): generate the tool set per session with `defineDynamic`
- [Sandbox](../sandbox): configure the sandbox used by shell and file tools
- [Subagents](../subagents): declare agents the model can call directly
