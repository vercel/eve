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

`defaultTools` doesn't affect [`eve__search` and `eve__execute`](#eve__search-and-eve__execute): eve adds them from what the agent declares, as listed in that section.

### `bash`

`bash` runs shell commands in the agent's [sandbox](../sandbox).

```sh
eve add tool/bash
```

```ts title="agent/tools/bash.ts"
export { default } from "eve/tools/bash";
```

`bash` waits up to 30 seconds for a command. A command that finishes in time returns `status: "completed"` with `exitCode`, `stdout`, `stderr`, and `truncated`. A command that is still running keeps running in the sandbox as its own process group and returns `status: "running"` with:

- `pid`: the process group id
- `outputDirectory`: a directory under `/tmp/.eve/jobs/`
- `stdout`, `stderr`, and `truncated`: the output so far
- `message`: instructions for the model

The command keeps writing to `stdout` and `stderr` files in `outputDirectory` and writes its exit code to an `exit` file when it finishes. The model checks on or stops it with ordinary shell commands in later `bash` calls, so the tool's approval policy applies to them:

```sh
tail /tmp/.eve/jobs/3f9a1c2e/stdout   # latest output
cat /tmp/.eve/jobs/3f9a1c2e/exit      # exit code, once the command has finished
kill -- -4312                         # stop the command's whole process group
```

The command keeps running across turns until it exits, the model stops it, or the sandbox stops. Its output files stay in the sandbox until the sandbox stops. Cancelling a turn stops a command that has not yet returned `running`. The `just-bash` provider has no background processes, so it runs every command to completion.

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

`read_file` reads text files from the sandbox with line-numbered output, and shows PNG, JPEG, GIF, and WebP images up to 3 MiB to the model as images. Images are detected from their bytes, so a missing or mismatched filename extension does not matter, and text files are always read as text. It accepts absolute paths and paths beginning with `$HOME/`.

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

Select Browserbase Search in the same slot:

```ts title="agent/tools/web_search.ts"
import { webSearch } from "eve/tools/web_search";

export default webSearch({ provider: "browserbase" });
```

Use a [Gateway model ID](../agent-config#set-the-model) to route searches through Browserbase. AI Gateway executes the search using `AI_GATEWAY_API_KEY` or Vercel project OIDC credentials; no `BROWSERBASE_API_KEY` is needed. See [Browserbase Search on AI Gateway](https://vercel.com/docs/ai-gateway/models-and-providers/web-search#using-browserbase-search).

The `provider` setting applies only to AI Gateway models. Unsupported direct providers omit `web_search`.

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

### `agent`

`agent` delegates a subtask to a fresh copy of the root agent. It is root-only, and each call is a [task](/docs/tools/tasks): the call returns a receipt, and the child's reply arrives later as the task's result. The child receives the root's instructions, tools, connections, and sandbox, but starts with fresh conversation history and [state](./state). See [Subagents](../subagents).

```sh
eve add tool/agent
```

```ts title="agent/tools/agent.ts"
export { default } from "eve/tools/agent";
```

An authored tool at `agent/tools/agent.ts` replaces the framework behavior. Re-export the definition above to restore direct root-copy delegation, export another tool such as `agentRouter()` to change the model-facing behavior, or disable the slot. `agentRouter()` runs each call as a [task](/docs/tools/workflows#run-calls-as-tasks-task), which adds `eve__task_wait` and `eve__task_cancel`:

```ts title="agent/tools/agent.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `eve__search` and `eve__execute`

`eve__search` and `eve__execute` let the model reach entries that are not in its tool list: tools defined with `deferred: true`, agents defined with `tool: "deferred"`, and every tool from the agent's [connections](../connections). The model also loads every [skill](../skills) through `eve__execute`. There is no add command; eve adds them from what the agent declares, even when `defaultTools` is `false`:

- `eve__search` and `eve__execute` come with anything `eve__search` could find: a deferred tool, agent, or skill, a connection, or a dynamic resolver (`agent/tools/`, `agent/skills/`, `agent/subagents/`, or `agent/connections/`) that may add one at runtime.
- An agent whose only such entries are listed skills gets `eve__execute` alone, in a form that takes only `skill`.
- An agent with none of these gets neither tool.

The decision depends only on what the agent declares, never on what its resolvers return, so the tool list stays the same for a deployment and never changes within a session.

- `eve__search({ query, limit? })` returns the best matches, up to `limit` (default 20, at most 50). `query` is required and must contain a word. A tool match has its exact `tool` name, its `description`, and a TypeScript `signature` rendered from its schemas. A deferred skill's match has its `skill` name, its `description`, and the `path` of its `SKILL.md` when it has supporting files. Tools and skills rank together, in tiers: an entry whose name is exactly the query, then a connection tool whose name is the query without its `<connection>__` prefix, then the tools of a connection named by the query, then entries whose names start with the query, then keyword matches in names, parameters, and descriptions. So `eve__search({ query: "linear" })` lists the `linear` connection's tools first.
- A query whose first word contains `__` searches one namespace: everything before its last `__`, without trailing underscores. The namespace only filters. `eve__search` keeps names under `<namespace>__` and anything named exactly the namespace, such as a connection's sign-in entry, then ranks them by the whole query, so `eve__search({ query: "linear__" })` returns only the `linear` connection's tools, or its sign-in result, and an exact name that contains `__` still ranks first. eve lists only the connections that can own names in that namespace, so other connections make no network call and don't appear in `unavailable`. A namespace that matches nothing fails with the closest connection names. Characters that can't appear in a name, such as a leading `^`, are ignored; `query` isn't a regular expression.
- `eve__search` never asks the user to sign in. A connection whose server won't list its tools until the user signs in appears as one result named after the connection, such as `linear`; a connection whose server lists its tools without a token is searched like any other. A connection whose tools fail to load appears under `unavailable` with its `error`. Matches from everything else are still returned.
- `eve__execute({ tool: "linear" })`, with a connection's own name, asks the user to sign in to that connection when its tools need it, and returns once they can be listed, so the next `eve__search` finds them. On a server that lists its tools without sign-in, it confirms the tools are available without asking.
- `eve__execute({ tool, input })` calls the entry named `tool` with `input`. A connection tool's name is `<connection>__<tool>`, such as `linear__list_issues`. eve checks `input` against the entry's input schema. An invalid input fails with the entry's signature, an unknown name fails with the closest names, and a tool already in the model's tool list fails with a reminder to call it directly. When the server asks for the user's authorization, the call asks the user to sign in and parks until sign-in completes.
- `eve__execute({ skill })` loads the named skill, deferred or not, and returns its instructions. An unknown name fails with the closest skill names. A name that matches a connection says to find its tools with `eve__search({ query: "<connection>__" })`. Pass exactly one of `tool` or `skill`. A skill takes no `input`: omit it or pass `{}`. Without `eve__search`, `eve__execute` takes only `skill`; without skills, it takes only `tool` and `input`.

After `eve__execute` resolves its entry, the call runs exactly like a direct call to that entry. A skill load reports a `load-skill` action named for its skill and an `execute_tool eve:load-skill` span. Approval policies and `approvedTools`, workflow tools and tasks, agents, `endsTurn`, `toModelOutput`, hooks, and stream events all see the entry's own name and input, such as `linear__list_issues`. Only model history records the call as `eve__execute`.

eve tells the model what it can reach in an append-only context message rather than in the system prompt: which kinds of deferred entries exist, up to 20 namespaces (the first `__` segment of deferred names, such as `sre` for `sre__list_alerts`), and up to 20 connections with their descriptions. It never names a deferred entry, so deferred entries stay out of context until `eve__search` finds them. A later step appends the listing again only when that changes; a deferred entry added to a listed namespace, or without one, changes nothing. The definitions of `eve__search` and `eve__execute` never change, so adding a deferred entry, signing in, or resolving a dynamic connection keeps the cached prompt prefix.

The tools eve adds itself all live in the `eve` namespace: `eve__search`, `eve__execute`, `eve__task_wait`, `eve__task_cancel`, and `eve__reply`. Nothing you author or resolve may be named `eve` or start with `eve__`: tools, subagents, skills, connections, and extension mounts, static or dynamic, since a connection or mount named `eve` would own every `eve__` name. The compiler rejects an authored tool, skill, connection, or mount, such as `agent/tools/eve__search.ts`; eve rejects an authored subagent when the agent loads, and a dynamic entry when its resolver returns it. Any other name is free, including `search` and `execute`. A connection's own name is also the entry that signs the user in to it.

### `eve__task_wait` and `eve__task_cancel`

eve adds `eve__task_wait` and `eve__task_cancel` when the agent has a tool that runs its calls as [tasks](/docs/tools/tasks): any agent tool, including the built-in `agent` tool, declared subagents, and remote agents, or a tool such as `agentRouter()`, the `workflow` tool, or an authored workflow tool that defines `task(input, ctx)` or `serve(receive, ctx)`. There is no add command, and the tools are not workflow tools. Like every `eve__` name, both are reserved.

- `eve__task_wait({ timeoutSeconds? })` parks the turn until any task has a result, a new message arrives, or `timeoutSeconds` pass, and returns at once when a result is already waiting. While it waits, the stream reports `turn.waiting` for the open turn. Results arrive in a `<task_result>` message right after it returns. Waiting never stops a task.
- `eve__task_cancel({ taskId })` stops a task's current work and says so, or says the task had no work to stop when it already finished or is an idle [resumable task](/docs/tools/workflows#resumable-tasks-serve). An id that names no task fails with `UNKNOWN_TASK`. A resumable task stays available after a cancel.

Review these tools before production use. Disable, wrap, restrict, or require approval for any tool that can access the filesystem, network, shell, or sensitive data.

You can also add the opt-in framework tools described below.

## Opt-in framework tools

These framework-provided tools are not added by default. Add only the ones the agent needs.

### `ask_question`

`ask_question` lets the model ask the user one question, then waits for the answer. The model can offer two or three options, each with a label and a short description, and the user can always type their own answer instead. Channels render the options as native UI, such as Slack select menus. Without the tool, the model can still ask in its reply text and the user answers with their next message. See [Human-in-the-loop](/docs/human-in-the-loop). Add it:

```sh
eve add tool/ask_question
```

```ts title="agent/tools/ask_question.ts"
import { askQuestion } from "eve/tools/ask_question";

export default askQuestion();
```

`ask_question` is a [workflow tool](/docs/tools/workflows) that calls `ctx.ask()`. The model receives `{ status: "answered", answer }`, where `answer` is the chosen option's label or the user's own words. A plain follow-up message answers the question too when it is the only pending question. When other questions are also pending, a message does not answer any of them: `ask_question` withdraws its question, resolves as `{ interrupted: true }`, which the model reads as `Stopped early because a new message arrived.`, and the model reads the message next. In a session that cannot request input, such as a scheduled run, the result is `{ status: "unavailable" }` and the model continues on its own judgment. Remove the file to remove the tool.

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

### `no_reply`

`no_reply` ends the turn without a reply. Use it when a scheduled check finds nothing to report, or when an action the agent already took is the whole answer. The model calls it with an optional `{ reason }`, which stays in the session history and traces and is never sent. The turn completes without a final message, so channels and schedule sends post nothing, and later turns see that the agent chose to stay quiet. Add it:

```sh
eve add tool/no_reply
```

```ts title="agent/tools/no_reply.ts"
import { noReply } from "eve/tools/no_reply";

export default noReply();
```

`no_reply` is a `defineTool` tool with [`endsTurn: true`](/docs/tools#end-the-turn-after-a-tool-call), so the turn ends only when no other tool runs in the same step. Only root sessions receive it. Slack clears the thread status when the turn completes. Remove the file to remove the tool.

### `sleep`

`sleep` pauses and durably resumes the current turn. The model calls it with `{ seconds }`; the wait does not hold an application runtime open. Concurrent calls run in parallel, and the turn resumes after the longest wait. A steering message, the default for a new message, ends the wait early: `sleep` returns `{ interrupted: true }`, which the model reads as `Stopped early because a new message arrived.`, followed by the message. Add it:

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
- [Subagents](../subagents): declare specialists that the model can delegate to
