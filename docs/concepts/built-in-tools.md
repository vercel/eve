---
title: "Built-in Tools"
description: "The default and opt-in tools eve provides, including glob, grep, and sleep."
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

- **`agent`** is available only in the root session and always runs in the background. Its call returns a task receipt immediately, and task notifications deliver updates or the final result. The child uses the root's instructions, tools, connections, and sandbox, but starts with fresh conversation history and fresh [state](./state). The child receives neither `agent` nor `Workflow`; declared subagents do not receive the built-in `agent` either. See [Subagents](../subagents).
- **`load_skill`** only pulls instructions into context. It adds no new execution surface, because behavior still comes from the tools the agent already has.
- **`connection_search`** surfaces a connection's tools by their qualified name (e.g. `linear__list_issues`), which the model can then call directly. The model sees it only when the agent has connections.
- **`web_search`** has no local executor; the provider runs it. AI Gateway models use Exa by default. To use Parallel instead, export `webSearch({ provider: "parallel" })` from `agent/tools/web_search.ts`. Direct provider models continue to use their native search implementation. To supply your own implementation, override it with `defineTool()`.
- **`web_fetch`** follows up to ten redirects, rechecking every destination for SSRF safety. Non-success HTTP responses return a plain-text failure result with the response body when available instead of failing the tool call.

Review these default tools before production use. Disable, wrap, restrict, or require approval for any tool that can access the filesystem, network, shell, or sensitive data.

### Disable all default tools

Default tools are enabled unless you set `defaultTools: false` in `agent/agent.ts`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  defaultTools: false,
  model: "openai/gpt-5.4",
});
```

This setting removes only the tools eve adds automatically. Files under `agent/tools/` still add their tools, including same-name replacements such as `agent/tools/bash.ts`. You can also add the opt-in framework tools described below.

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

The section below covers `sleep` in more detail.

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

## Disable default tools

Set `defaultTools: false` in `agent/agent.ts` to remove every default at once, as described in [Disable all default tools](#disable-all-default-tools). Tools under `agent/tools/` remain available.

To remove one default, export a `disableTool()` sentinel from a file named after the tool's slug. The filename picks the default to remove:

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

## The opt-in `sleep` tool

The framework also ships a durable `sleep` tool, but does not add it to agents by default. Enable it with `agent/tools/sleep.ts`:

```ts
import { sleep } from "eve/tools/sleep";

export default sleep();
```

The model calls it with `{ seconds }` when it is useful to wait before checking progress or status again. Each call runs as a durable tool workflow, so it does not hold an application runtime open, and the same turn continues automatically when the duration elapses. Concurrent `sleep` calls run in parallel, so the turn continues after the longest requested duration.

## What to read next

- [Tools](../tools): define your own tools, gate them on approval, and shape their output with `toModelOutput`
- [Dynamic capabilities](../guides/dynamic-capabilities): generate the tool set per session with `defineDynamic`
- [Sandbox](../sandbox): configure the sandbox used by shell and file tools
- [Subagents](../subagents): declare specialists that the model can call as background tasks
