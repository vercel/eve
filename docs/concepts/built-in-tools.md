---
title: "Built-in Tools"
description: "The default and opt-in tools eve provides, including glob, grep, and sleep."
---

eve provides a default tool set for every agent and additional tools you can add with one file. Each default occupies the same `agent/tools/<name>.ts` slot you would author yourself, so an authored definition replaces it and `disableTool()` removes it. Use this page to review what the model can call, opt into more capabilities, or override and disable defaults. For custom tools, see [Tools](../tools).

## Default tools

Default tools require no imports. The exact set depends on the agent and session, and the harness advertises only the tools available to the current session.

### Disable optional default tools

Optional default tools are enabled unless you set `defaultTools: false` in `agent/agent.ts`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  defaultTools: false,
  model: "openai/gpt-5.4",
});
```

This turns off the optional defaults described below. Add back only the tools the agent needs with the command in each tool's section. Existing files under `agent/tools/` remain available, including same-name replacements such as `agent/tools/bash.ts`.

`connection_search` stays available when the agent has connections because it provides access to their tools.

### `bash`

`bash` runs shell commands in the agent's [sandbox](../sandbox).

```sh
eve add tool/bash
```

### `read_file`

`read_file` reads text files from the sandbox with line-numbered output. It accepts absolute paths and paths beginning with `$HOME/`.

```sh
eve add tool/read_file
```

### `write_file`

`write_file` writes complete files in the sandbox. It enforces read-before-write and stale-read detection, and accepts absolute paths and paths beginning with `$HOME/`.

```sh
eve add tool/write_file
```

### `web_fetch`

`web_fetch` fetches URLs from the app runtime. It follows up to ten redirects and checks every destination for SSRF safety. Non-success responses return plain text with the response body when available.

```sh
eve add tool/web_fetch
```

### `web_search`

`web_search` uses provider-managed web search and appears only for supported model providers. AI Gateway models use Exa by default; direct provider models use their native search implementation.

```sh
eve add tool/web_search
```

To use Parallel with AI Gateway, export `webSearch({ provider: "parallel" })` from `agent/tools/web_search.ts`. To provide your own implementation, override the tool with `defineTool()`.

### `todo`

`todo` maintains a durable todo list for the session.

```sh
eve add tool/todo
```

### `ask_question`

`ask_question` asks the user for clarification or a choice, then parks the turn until they answer. It appears only when the session can request user input. See [Human-in-the-loop](/docs/human-in-the-loop).

```sh
eve add tool/ask_question
```

### `agent`

`agent` delegates a subtask to a fresh copy of the root agent. It is root-only, always runs in the background, and returns a task receipt immediately. The child receives the root's instructions, tools, connections, and sandbox, but starts with fresh conversation history and [state](./state). See [Subagents](../subagents).

```sh
eve add tool/agent
```

### `task_cancel`

`task_cancel` lets the root session cancel background tasks.

```sh
eve add tool/task_cancel
```

### `task_update`

`task_update` lets a background task report progress to its parent. It appears only in delegated task sessions.

```sh
eve add tool/task_update
```

### `load_skill`

`load_skill` pulls an on-demand [skill](../skills)'s instructions into the current turn. It appears only when the agent declares skills and adds no execution surface by itself.

```sh
eve add tool/load_skill
```

### `connection_search`

`connection_search` discovers tools across declared [connections](../connections) and makes matches directly callable by qualified name, such as `linear__list_issues`. eve adds it automatically when connections exist, even when `defaultTools` is `false`, so there is no add command.

Review these tools before production use. Disable, wrap, restrict, or require approval for any tool that can access the filesystem, network, shell, or sensitive data.

You can also add the opt-in framework tools described below.

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

Author a tool at the same slug and it takes over the built-in of that name. When present, `agent/tools/write_file.ts` replaces the built-in `write_file`:

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

| Definition         | Import                        | Registered by default |
| ------------------ | ----------------------------- | --------------------- |
| `bash`             | `eve/tools/bash`              | Yes                   |
| `readFile`         | `eve/tools/read_file`         | Yes                   |
| `writeFile`        | `eve/tools/write_file`        | Yes                   |
| `todo`             | `eve/tools/todo`              | Yes                   |
| `webFetch`         | `eve/tools/web_fetch`         | Yes                   |
| `loadSkill`        | `eve/tools/load_skill`        | Yes                   |
| `connectionSearch` | `eve/tools/connection_search` | With connections      |
| `agent`            | `eve/tools/agent`             | Yes                   |
| `askQuestion`      | `eve/tools/ask_question`      | Yes                   |
| `taskCancel`       | `eve/tools/task_cancel`       | Yes                   |
| `taskUpdate`       | `eve/tools/task_update`       | Yes                   |
| `glob`             | `eve/tools/glob`              | No                    |
| `grep`             | `eve/tools/grep`              | No                    |

Importing a definition does not add it to an agent; export it from the corresponding `agent/tools/*.ts` file. Skip the spread and your replacement owns its own context. A fresh `defineTool` for `todo` does not inherit the default's durable state key.

Provider-managed web search has a dedicated configuration helper instead of an executable default:

```ts title="agent/tools/web_search.ts"
import { webSearch } from "eve/tools/web_search";

export default webSearch({ provider: "parallel" });
```

Set `provider` to `"exa"` or `"parallel"`. Without this file, AI Gateway models use Exa.

## Disable default tools

Set `defaultTools: false` in `agent/agent.ts` to remove the optional defaults at once, as described in [Disable optional default tools](#disable-optional-default-tools). `connection_search` remains available when the agent has connections, and tools under `agent/tools/` remain available.

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
