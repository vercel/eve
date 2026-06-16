---
title: "The Harness"
description: "The out-of-the-box agent loop and the built-in tools every Eve agent ships with, plus how to override or disable them."
---

The default harness is what every Eve agent ships with: the framework-owned agent loop, plus a set of built-in tools the model can call without you writing a line. You extend the base harness with capabilities specific to your agent. The loop itself, how a turn runs and checkpoints and resumes, lives in [Execution model & durability](./execution-model-and-durability).

## Compaction

A long session eventually fills the model's context window. The harness handles that for you: once the conversation crosses a fraction of the window (`thresholdPercent`, `0.9` by default), it summarizes the older turns into a compact form and keeps going, so the session continues instead of overflowing. The summary uses the active turn model unless you override it. Tune when and how it kicks in under [`compaction`](../agent-config#compaction) in `agent.ts`:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  compaction: {
    thresholdPercent: 0.75,
  },
});
```

Compaction also preserves the framework's own tool state automatically. When the harness compacts history, it resets read-before-write tracking (so a write afterward re-reads the file whose read evidence was summarized away) and re-injects the active todo list, so the model keeps its task list across the summary. There is no per-tool hook to configure.

## Built-in tools

These ship with every agent, no imports. Discovery never runs them: the harness shows the model the tool descriptors first, then executes only what the model actually calls. The shell and file tools run inside the agent's single [sandbox](../sandbox); the rest run in the app runtime.

| Tool                | Does                                                                                                                                                              | Where it runs |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `bash`              | Run a shell command.                                                                                                                                              | Sandbox       |
| `read_file`         | Read a text file with line-numbered output (enables read-before-write).                                                                                           | Sandbox FS    |
| `write_file`        | Write a complete file; enforces read-before-write and stale-read detection.                                                                                       | Sandbox FS    |
| `glob`              | Find files by glob pattern.                                                                                                                                       | Sandbox FS    |
| `grep`              | Search file contents by regex.                                                                                                                                    | Sandbox FS    |
| `web_fetch`         | Fetch a URL.                                                                                                                                                      | App runtime   |
| `web_search`        | Search the web (provider-managed; resolved from the model provider).                                                                                              | Provider      |
| `todo`              | Maintain a durable per-session todo list.                                                                                                                         | App runtime   |
| `ask_question`      | Ask the user a clarifying question or a choice mid-turn and park until they answer. No `execute`; the model calls it with `{ prompt, options?, allowFreeform? }`. | App runtime   |
| `agent`             | Delegate a subtask to a copy of itself (shares the parent sandbox + tools, fresh history/state).                                                                  | App runtime   |
| `load_skill`        | Pull an on-demand [skill](../skills)'s instructions into the current turn. Present only when the agent declares skills.                                           | App runtime   |
| `connection_search` | Discover tools across declared [connections](../connections); matched tools become directly callable. Present only when the agent declares connections.           | App runtime   |

Notes:

- **`agent`** runs a copy of the current agent on a focused task. It inherits the same tools, connections, and instructions, but starts with fresh conversation history and fresh [state](../guides/state). The child shares the parent's sandbox filesystem, so anything it writes is visible to the parent. See [Subagents](../subagents).
- **`load_skill`** only pulls instructions into context. It adds no new execution surface, because behavior still comes from the tools the agent already has.
- **`connection_search`** is the model-facing `connection__search` tool. A search surfaces a connection's tools by their qualified name (e.g. `connection__linear__list_issues`), and the model can then call them directly. It's registered only when the agent has connections.
- **`web_search`** has no local executor; the provider runs it. To supply your own implementation, override it with `defineTool()`.

## Override a default

Author a tool at the same slug and it takes over the built-in of that name. The file `agent/tools/write_file.ts` replaces the built-in `write_file` just by existing:

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

The framework defaults are importable from `eve/tools/defaults` (`bash`, `readFile`, `writeFile`, `glob`, `grep`, `webFetch`, `webSearch`, `todo`, `loadSkill`), so you can spread, wrap, or patch them. Skip the spread and your replacement owns its own context: a fresh `defineTool` for `todo` won't inherit the framework's durable state key.

## Disable a default

Export a `disableTool()` sentinel from a file named after the tool's slug. The filename is what picks the default to remove:

```ts title="agent/tools/bash.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

Misspell the filename so it matches no known framework tool and it fails at resolve time, instead of silently doing nothing.

## The opt-in `Workflow` tool

There's also an experimental `Workflow` tool, shipped but off by default. To turn it on, re-export the opt-in marker from `agent/tools/workflow.ts`:

```ts
export { ExperimentalWorkflow as default } from "eve/tools";
```

With it on, the model can orchestrate the agent's own subagents from model-authored JavaScript, all as one durable step. See [Dynamic workflows](../guides/dynamic-workflows).

## What to read next

- [Tools](../tools): define your own tools, gate them on approval, and shape their output with `toModelOutput`
- [Dynamic capabilities](../guides/dynamic-capabilities): generate the tool set per session with `defineDynamic`
- [Sandbox](../sandbox): the sandbox the shell and file tools run in
