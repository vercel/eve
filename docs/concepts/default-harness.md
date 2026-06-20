---
title: "The Harness"
description: "The out-of-the-box eve agent loop and the built-in tools every agent ships with, plus how to override or disable them."
---

The default harness is what every eve agent ships with. It includes the framework-owned agent loop plus a set of built-in tools the model can call without you writing a line. You extend it with capabilities specific to your agent. The loop itself, how a turn runs and checkpoints and resumes, lives in [Execution model and durability](./execution-model-and-durability).

## Compaction

The harness keeps a long session from overflowing the model's context window. Once the conversation crosses a fraction of the window (`thresholdPercent`, `0.9` by default), it summarizes the older turns into a compact form and keeps going. The summary uses the active turn model unless you override it. Tune when and how it kicks in under [`compaction`](../agent-config#compaction) in `agent.ts`:

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

These ship with every agent, no imports. The harness shows the model the tool descriptors first, then executes only what the model actually calls; discovery never runs them. The shell and file tools (`bash`, `read_file`, `write_file`, `glob`, `grep`) live in the app runtime and proxy their work into the agent's single [sandbox](../sandbox); the rest run in the app runtime. The "Where it runs" column below names where each tool's effect lands.

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
| `agent`             | Delegate a subtask to a copy of itself (shares the parent sandbox + tools, fresh history/state).                                                                                                                    | App runtime   |
| `load_skill`        | Pull an on-demand [skill](../skills)'s instructions into the current turn. Present only when the agent declares skills.                                                                                             | App runtime   |
| `connection_search` | Discover tools across declared [connections](../connections); matched tools become directly callable. Present only when the agent declares connections.                                                             | App runtime   |

Notes:

- **`agent`** runs a copy of the current agent on a focused task. It inherits the same tools, connections, and instructions, but starts with fresh conversation history and fresh [state](../guides/state). The child shares the parent's sandbox filesystem, so anything it writes is visible to the parent. See [Subagents](../subagents).
- **`load_skill`** only pulls instructions into context. It adds no new execution surface, because behavior still comes from the tools the agent already has.
- **`connection_search`** is the model-facing `connection__search` tool. A search surfaces a connection's tools by their qualified name (e.g. `connection__linear__list_issues`), and the model can then call them directly. It's registered only when the agent has connections.
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

If the filename matches no known framework tool, resolution fails instead of silently doing nothing, so a typo surfaces at build time rather than removing the wrong tool.

## When to override, disable, or author a new tool

Three moves shape the harness. The right one depends on whether the model should keep the built-in capability.

- **Override** when you want the same capability with different behavior. Spread the default from `eve/tools/defaults` and wrap it (logging, an extra guard, a different backend), and the model still sees a tool by that name. Spreading keeps the default's description, schema, and any framework state, such as the `todo` tool's durable state key. Drop the spread and your replacement owns its own context, losing that wiring.
- **Disable** when the model should not have the capability at all. A `disableTool()` sentinel removes the built-in, and the model never sees it. Reach for this to lock down `bash` or `web_fetch` in an agent that should not run shell commands or fetch arbitrary URLs.
- **Author a new tool** when you want a capability the harness does not ship. Give it a fresh slug under `agent/tools/` and it joins the built-ins instead of replacing one. See [Tools](../tools) for the authoring model.

## The opt-in `Workflow` tool

An experimental `Workflow` tool ships but stays off by default. To turn it on, re-export the opt-in marker from `agent/tools/workflow.ts`:

```ts
export { ExperimentalWorkflow as default } from "eve/tools";
```

With it on, the model can orchestrate the agent's own subagents from model-authored JavaScript, all as one durable step. See [Dynamic workflows](../guides/dynamic-workflows).

## What to read next

- [Tools](../tools): define your own tools, gate them on approval, and shape their output with `toModelOutput`
- [Dynamic capabilities](../guides/dynamic-capabilities): generate the tool set per session with `defineDynamic`
- [Sandbox](../sandbox): the sandbox the shell and file tools run in
