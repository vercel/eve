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

```ts title="agent/tools/bash.ts"
export { default } from "eve/tools/bash";
```

Override its description, approval policy, or executor by wrapping the exported definition:

```ts title="agent/tools/bash.ts"
import { defineTool } from "eve/tools";
import { bash } from "eve/tools/bash";

export default defineTool({
  ...bash,
  description: "Run approved project maintenance commands.",
  async execute(input, ctx) {
    console.info("Running sandbox command", input.command);
    return bash.execute(input, ctx);
  },
});
```

Disable only `bash`:

```ts title="agent/tools/bash.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `read_file`

`read_file` reads text files from the sandbox with line-numbered output. It accepts absolute paths and paths beginning with `$HOME/`.

```sh
eve add tool/read_file
```

```ts title="agent/tools/read_file.ts"
export { default } from "eve/tools/read_file";
```

Override it:

```ts title="agent/tools/read_file.ts"
import { defineTool } from "eve/tools";
import { readFile } from "eve/tools/read_file";

export default defineTool({
  ...readFile,
  description: "Read project files from the sandbox.",
});
```

Disable it:

```ts title="agent/tools/read_file.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `write_file`

`write_file` writes complete files in the sandbox. It enforces read-before-write and stale-read detection, and accepts absolute paths and paths beginning with `$HOME/`.

```sh
eve add tool/write_file
```

```ts title="agent/tools/write_file.ts"
export { default } from "eve/tools/write_file";
```

Override it:

```ts title="agent/tools/write_file.ts"
import { defineTool } from "eve/tools";
import { writeFile } from "eve/tools/write_file";

export default defineTool({
  ...writeFile,
  description: "Write approved project files in the sandbox.",
  async execute(input, ctx) {
    if (!input.filePath.startsWith("/workspace/")) {
      throw new Error("write_file is limited to /workspace");
    }
    return writeFile.execute(input, ctx);
  },
});
```

Disable it:

```ts title="agent/tools/write_file.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `web_fetch`

`web_fetch` fetches URLs from the app runtime. It follows up to ten redirects and checks every destination for SSRF safety. Non-success responses return plain text with the response body when available.

```sh
eve add tool/web_fetch
```

```ts title="agent/tools/web_fetch.ts"
export { default } from "eve/tools/web_fetch";
```

Override it:

```ts title="agent/tools/web_fetch.ts"
import { defineTool } from "eve/tools";
import { webFetch } from "eve/tools/web_fetch";

export default defineTool({
  ...webFetch,
  description: "Fetch approved public documentation URLs.",
  async execute(input, ctx) {
    const hostname = new URL(input.url).hostname;
    if (hostname !== "docs.example.com") {
      throw new Error("web_fetch is limited to docs.example.com");
    }
    return webFetch.execute(input, ctx);
  },
});
```

Disable it:

```ts title="agent/tools/web_fetch.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `web_search`

`web_search` uses provider-managed web search and appears only for supported model providers. AI Gateway models use Exa by default; direct provider models use their native search implementation.

```sh
eve add tool/web_search
```

```ts title="agent/tools/web_search.ts"
export { default } from "eve/tools/web_search";
```

Override the provider-managed configuration for AI Gateway:

```ts title="agent/tools/web_search.ts"
import { webSearch } from "eve/tools/web_search";

export default webSearch({ provider: "parallel" });
```

Replace provider-managed search with an authored implementation:

```ts title="agent/tools/web_search.ts"
import { defineTool } from "eve/tools";

export default defineTool({
  description: "Search the internal documentation index.",
  inputSchema: { type: "object" },
  async execute(input) {
    return { results: [], query: input };
  },
});
```

Disable it:

```ts title="agent/tools/web_search.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `todo`

`todo` maintains a durable todo list for the session.

```sh
eve add tool/todo
```

```ts title="agent/tools/todo.ts"
export { default } from "eve/tools/todo";
```

Override it. Spreading the definition preserves its durable state key:

```ts title="agent/tools/todo.ts"
import { defineTool } from "eve/tools";
import { todo } from "eve/tools/todo";

export default defineTool({
  ...todo,
  description: "Track the current implementation plan.",
});
```

Disable it:

```ts title="agent/tools/todo.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `ask_question`

`ask_question` asks the user for clarification or a choice, then parks the turn until they answer. It appears only when the session can request user input. See [Human-in-the-loop](/docs/human-in-the-loop).

```sh
eve add tool/ask_question
```

```ts title="agent/tools/ask_question.ts"
export { default } from "eve/tools/ask_question";
```

Replace its request-input behavior with an ordinary authored tool:

```ts title="agent/tools/ask_question.ts"
import { defineTool } from "eve/tools";

export default defineTool({
  description: "Record a clarification request.",
  inputSchema: { type: "object" },
  async execute(input) {
    return { recorded: input };
  },
});
```

Disable it:

```ts title="agent/tools/ask_question.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `agent`

`agent` delegates a subtask to a fresh copy of the root agent. It is root-only, always runs in the background, and returns a task receipt immediately. The child receives the root's instructions, tools, connections, and sandbox, but starts with fresh conversation history and [state](./state). See [Subagents](../subagents).

```sh
eve add tool/agent
```

```ts title="agent/tools/agent.ts"
export { default } from "eve/tools/agent";
```

The framework behavior cannot be overridden. Re-export the definition above to restore it, or disable it:

```ts title="agent/tools/agent.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `task_cancel`

`task_cancel` lets the root session cancel background tasks.

```sh
eve add tool/task_cancel
```

```ts title="agent/tools/task_cancel.ts"
export { default } from "eve/tools/task_cancel";
```

The framework behavior cannot be overridden. Re-export the definition above to restore it, or disable it:

```ts title="agent/tools/task_cancel.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `task_update`

`task_update` lets a background task report progress to its parent. It appears only in delegated task sessions.

```sh
eve add tool/task_update
```

```ts title="agent/tools/task_update.ts"
export { default } from "eve/tools/task_update";
```

The framework behavior cannot be overridden. Re-export the definition above to restore it, or disable it:

```ts title="agent/tools/task_update.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `load_skill`

`load_skill` pulls an on-demand [skill](../skills)'s instructions into the current turn. It appears only when the agent declares skills and adds no execution surface by itself.

```sh
eve add tool/load_skill
```

```ts title="agent/tools/load_skill.ts"
export { default } from "eve/tools/load_skill";
```

Override it:

```ts title="agent/tools/load_skill.ts"
import { defineTool } from "eve/tools";
import { loadSkill } from "eve/tools/load_skill";

export default defineTool({
  ...loadSkill,
  description: "Load instructions for an available skill.",
});
```

Disable it:

```ts title="agent/tools/load_skill.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `connection_search`

`connection_search` discovers tools across declared [connections](../connections) and makes matches directly callable by qualified name, such as `linear__list_issues`. eve adds it automatically when connections exist, even when `defaultTools` is `false`, so there is no add command.

An authored `agent/tools/connection_search.ts` replaces the framework behavior. Import the framework definition from `eve/tools/connection_search` when you need to reference it directly. Exporting `disableTool()` from this slot is an error because agents with connections require connection discovery.

Review these tools before production use. Disable, wrap, restrict, or require approval for any tool that can access the filesystem, network, shell, or sensitive data.

You can also add the opt-in framework tools described below.

## Opt-in framework tools

These framework-provided tools are not added by default. Add only the ones the agent needs.

### `glob`

`glob` finds sandbox files by glob pattern. Add it:

```sh
eve add tool/glob
```

```ts title="agent/tools/glob.ts"
export { default } from "eve/tools/glob";
```

Customize it by wrapping the framework definition:

```ts title="agent/tools/glob.ts"
import { defineTool } from "eve/tools";
import { glob } from "eve/tools/glob";

export default defineTool({
  ...glob,
  description: "Find project files by glob pattern.",
});
```

Remove the file to remove the tool. `disableTool()` is unnecessary because `glob` is not added by default.

### `grep`

`grep` searches sandbox file contents with a regular expression. Add it:

```sh
eve add tool/grep
```

```ts title="agent/tools/grep.ts"
export { default } from "eve/tools/grep";
```

Customize it by wrapping the framework definition:

```ts title="agent/tools/grep.ts"
import { defineTool } from "eve/tools";
import { grep } from "eve/tools/grep";

export default defineTool({
  ...grep,
  description: "Search project files with a regular expression.",
});
```

Remove the file to remove the tool. `disableTool()` is unnecessary because `grep` is not added by default.

### `sleep`

`sleep` pauses and durably resumes the current turn. The model calls it with `{ seconds }`; the wait does not hold an application runtime open. Concurrent calls run in parallel, and the turn resumes after the longest wait. Add it:

```sh
eve add tool/sleep
```

```ts title="agent/tools/sleep.ts"
import { sleep } from "eve/tools/sleep";

export default sleep();
```

Customize it by wrapping the framework definition:

```ts title="agent/tools/sleep.ts"
import { defineWorkflowTool } from "eve/tools";
import { sleep } from "eve/tools/sleep";

export default defineWorkflowTool({
  ...sleep(),
  description: "Pause before checking an external operation again.",
});
```

Remove the file to remove the tool. `disableTool()` is unnecessary because `sleep` is not added by default.

## What to read next

- [Tools](../tools): define your own tools, gate them on approval, and shape their output with `toModelOutput`
- [Dynamic capabilities](../guides/dynamic-capabilities): generate the tool set per session with `defineDynamic`
- [Sandbox](../sandbox): configure the sandbox used by shell and file tools
- [Subagents](../subagents): declare specialists that the model can call as background tasks
