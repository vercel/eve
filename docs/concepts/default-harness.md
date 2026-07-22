---
title: "The Harness"
description: "How eve manages model context and built-in tools during an agent turn."
---

The default harness is eve's built-in agent loop. It manages model calls, compaction, and tool execution. You can extend it with capabilities specific to your agent. To see how turns checkpoint and resume, read [Execution model and durability](./execution-model-and-durability).

## Compaction

The harness keeps a long session from overflowing the model's context window. Before comparing the conversation with `thresholdPercent` (`0.9` by default), it adds the estimated fixed envelope of the checkpoint prompt used for compaction. It then summarizes the older turns and keeps going. The prompt asks the compaction model to distinguish completed progress and decisions from remaining work and to retain the constraints, preferences, data, and references needed to continue. When eve compacts again, it passes the previous checkpoint separately and without the transcript's per-message truncation, then replaces it with the updated checkpoint. The summary uses the active turn model unless you override it. Tune when and how it kicks in under [`compaction`](../agent-config#compaction) in `agent.ts`:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  compaction: {
    thresholdPercent: 0.75,
  },
});
```

Compaction also preserves the framework's own tool state automatically. It resets read-before-write tracking (so a write afterward re-reads the file whose read evidence was summarized away) and re-injects the active todo list, so the model keeps its task list across the summary. There is no per-tool hook to configure.

## Built-in tools

Built-in tools require no imports. The exact set depends on the agent and session. `agent` is available only in the root session; `load_skill` and `connection_search` appear only when the agent declares the corresponding resources; `ask_question` requires a session that can request user input; and `web_search` requires a supported model provider. The harness advertises only the tools available to the current session.

The shell and file tools (`bash`, `read_file`, `write_file`, `glob`, `grep`) run in the app and proxy their work into the agent's [sandbox](../sandbox). The table shows where each tool's effect lands.

| Tool                | Does                                                                                                                                                                                                                | Where it runs |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `bash`              | Run a shell command.                                                                                                                                                                                                | Sandbox       |
| `read_file`         | Read a text file with line-numbered output (enables read-before-write).                                                                                                                                             | Sandbox FS    |
| `write_file`        | Write a complete file; enforces read-before-write and stale-read detection.                                                                                                                                         | Sandbox FS    |
| `glob`              | Find files by glob pattern.                                                                                                                                                                                         | Sandbox FS    |
| `grep`              | Search file contents by regex.                                                                                                                                                                                      | Sandbox FS    |
| `web_fetch`         | Fetch a URL.                                                                                                                                                                                                        | App runtime   |
| `web_search`        | Search the web (provider-managed; resolved from the model provider).                                                                                                                                                | Provider      |
| `todo`              | Maintain a durable per-session todo list.                                                                                                                                                                           | App runtime   |
| `ask_question`      | Ask the user a clarifying question or a choice mid-turn and park until they answer. No `execute`; the model calls it with `{ prompt, options?, allowFreeform? }`. See [Human-in-the-loop](/docs/human-in-the-loop). | App runtime   |
| `agent`             | From the root session, delegate a subtask to a fresh copy of the root agent.                                                                                                                                        | App runtime   |
| `load_skill`        | Pull an on-demand [skill](../skills)'s instructions into the current turn. Present only when the agent declares skills.                                                                                             | App runtime   |
| `connection_search` | Discover tools across declared [connections](../connections); matched tools become directly callable. Present only when the agent declares connections.                                                             | App runtime   |

Notes:

- **`agent`** is available only in the root session. Its child uses the root's instructions, tools, connections, and sandbox, but starts with fresh conversation history and fresh [state](../guides/state). The child receives neither `agent` nor `Workflow`; declared subagents do not receive the built-in `agent` either. See [Subagents](../subagents).
- **`load_skill`** only pulls instructions into context. It adds no new execution surface, because behavior still comes from the tools the agent already has.
- **`connection_search`** surfaces a connection's tools by their qualified name (e.g. `linear__list_issues`), which the model can then call directly. It's registered only when the agent has connections.
- **`web_search`** has no local executor; the provider runs it. To supply your own implementation, override it with `defineTool()`.

Review these built-in tools before production use. Disable, wrap, restrict, or require approval for any tool that can access the filesystem, network, shell, or sensitive data.

## Override a default

Author a tool at the same slug and it takes over the built-in of that name. The file `agent/tools/write_file.ts` replaces the built-in `write_file` by existing:

```ts title="agent/tools/write_file.ts"
import { defineTool } from "eve/tools";
import { writeFile } from "eve/tools/defaults";

export default defineTool({
  ...writeFile, // keep the default description, schema, and executor
  async execute(input, ctx) {
    console.log("[write_file]", input.path);
    return writeFile.execute(input, ctx);
  },
});
```

The framework defaults are importable from `eve/tools/defaults` (`bash`, `readFile`, `writeFile`, `glob`, `grep`, `webFetch`, `webSearch`, `todo`, `loadSkill`), so you can spread, wrap, or patch them. Skip the spread and your replacement owns its own context. A fresh `defineTool` for `todo` won't inherit the framework's durable state key.

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

- **Override** when you want the same capability with different behavior. Spread the default from `eve/tools/defaults` and wrap it (logging, an extra guard, a different backend), and the model still sees a tool by that name. Spreading keeps the default's description, schema, and any framework state, such as the `todo` tool's durable state key. Drop the spread and your replacement owns its own context, losing that wiring.
- **Disable** when the model should not have the capability at all. A `disableTool()` sentinel removes the built-in, and the model never sees it. Reach for this to lock down `bash` or `web_fetch` in an agent that should not run shell commands or fetch arbitrary URLs.
- **Author a new tool** when you want a capability the harness does not ship. Give it a fresh slug under `agent/tools/` and it joins the built-ins instead of replacing one. See [Tools](../tools) for the authoring model.

## The opt-in `Workflow` tool

An experimental `Workflow` tool ships but stays off by default. To turn it on, export its definition from `agent/tools/workflow.ts`:

```ts
import { experimental_workflow } from "eve/tools";

export default experimental_workflow({ maxSubagents: 100 });
```

With it on, the model can orchestrate the agent's own subagents from model-authored JavaScript, all as one durable step. The tool is root-only — delegated subagent sessions never see it — and one program may dispatch at most the configured `maxSubagents` calls (default 100). See [Dynamic workflows](../guides/dynamic-workflows).

## What to read next

- [Tools](../tools): define your own tools, gate them on approval, and shape their output with `toModelOutput`
- [Dynamic capabilities](../guides/dynamic-capabilities): generate the tool set per session with `defineDynamic`
- [Sandbox](../sandbox): the sandbox the shell and file tools run in
