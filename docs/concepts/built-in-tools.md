---
title: "Built-in Tools"
description: "The default and opt-in tools eve provides, including glob, grep, and sleep."
---

Built-in tools are framework tools eve provides: a default set every agent gets, and opt-in tools you add with one file. Each occupies the same `agent/tools/<name>.ts` slot you would author yourself, so an authored definition replaces it and `disableTool()` removes it. For custom tools, see [Tools](../tools).

## Default tools

Default tools require no imports. The model sees only the defaults available to the current agent and session.

### Disable optional default tools

Optional default tools are enabled unless you set `defaultTools: false` in `agent/agent.ts`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  defaultTools: false,
  model: "openai/gpt-5.4",
});
```

Add back only the tools the agent needs with the command in each tool's section. Files under `agent/tools/` stay available, including same-name replacements such as `agent/tools/bash.ts`. `defaultTools` doesn't affect [the catalog tools](#eve__search-eve__tool-and-eve__skill), which eve adds from what the session can reach.

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

The command writes to `stdout` and `stderr` files in `outputDirectory`, and its exit code to an `exit` file when it finishes. The model checks on or stops it with shell commands in later `bash` calls, so the tool's approval policy applies to them:

```sh
tail /tmp/.eve/jobs/3f9a1c2e/stdout   # latest output
cat /tmp/.eve/jobs/3f9a1c2e/exit      # exit code, once the command has finished
kill -- -4312                         # stop the command's whole process group
```

The command runs across turns until it exits, the model stops it, or the sandbox stops, and its output files last until the sandbox stops. Cancelling a turn stops a command that hasn't yet returned `running`. The `just-bash` provider has no background processes, so it runs every command to completion.

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

`read_file` reads sandbox text files with line-numbered output. It also shows the model images and PDFs as files:

- PNG, JPEG, GIF, and WebP images up to 3 MiB and 8000 pixels per side
- PDFs up to 20 MiB

It detects images and PDFs from their bytes, so the filename extension doesn't matter.

It accepts absolute paths, paths relative to the workspace root where `bash` commands start, and paths beginning with `$HOME/`. Results and errors name the resolved absolute path.

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

`write_file` writes complete files in the sandbox. It enforces read-before-write and stale-read detection, and accepts the same paths as `read_file`.

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
  description: "Write notes in the sandbox's notes directory.",
  async execute(input, ctx) {
    const sandbox = await ctx.getSandbox();
    const notes = `${sandbox.resolvePath("notes")}/`;
    if (
      input.filePath.startsWith("$HOME") ||
      !sandbox.resolvePath(input.filePath).startsWith(notes)
    ) {
      throw new Error("write_file is limited to the notes directory");
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

`web_search` uses provider-managed web search and appears only for supported model providers. AI Gateway models use Exa unless you set `provider`; direct provider models use their native search.

```sh
eve add tool/web_search
```

```ts title="agent/tools/web_search.ts"
import { webSearch } from "eve/tools/web_search";

export default webSearch({ provider: "exa" });
```

Choose another AI Gateway search provider:

```ts title="agent/tools/web_search.ts"
import { webSearch } from "eve/tools/web_search";

export default webSearch({ provider: "parallel" });
```

Select Browserbase Search in the same slot:

```ts title="agent/tools/web_search.ts"
import { webSearch } from "eve/tools/web_search";

export default webSearch({ provider: "browserbase" });
```

Browserbase Search requires a [Gateway model ID](../agent-config#set-the-model). AI Gateway runs the search with `AI_GATEWAY_API_KEY` or Vercel project OIDC credentials, so no `BROWSERBASE_API_KEY` is needed. See [Browserbase Search on AI Gateway](https://vercel.com/docs/ai-gateway/models-and-providers/web-search#using-browserbase-search).

Select the model vendor's own hosted search for a model routed through AI Gateway:

```ts title="agent/tools/web_search.ts"
import { webSearch } from "eve/tools/web_search";

export default webSearch({ provider: "native" });
```

The vendor runs the search server-side and returns citations:

| Model vendor               | Search                  |
| -------------------------- | ----------------------- |
| OpenAI                     | OpenAI web search       |
| Anthropic                  | Anthropic web search    |
| Google, Gemini 3 and later | Google Search grounding |

AI Gateway uses its usual credentials, so no `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or Google key is needed. Every other Gateway model, including one picked by a dynamic model resolver and Gemini models before Gemini 3, doesn't get `web_search`.

eve picks the search tool from the requested model. A call that AI Gateway's `models` fallback serves with another vendor's model can therefore run without search.

Anthropic web search runs only on Anthropic's own API. AI Gateway tries another host when Amazon Bedrock or Google Vertex AI rejects the tool. If no host accepts it, eve retries the step without `web_search`.

Set `fallback` to give models without native search a provider that works with any Gateway model (`"exa"`, `"parallel"`, or `"browserbase"`):

```ts title="agent/tools/web_search.ts"
import { webSearch } from "eve/tools/web_search";

export default webSearch({ provider: "native", fallback: "exa" });
```

The `provider` setting applies only to AI Gateway models. Direct OpenAI, Anthropic, and Gemini 3 and later models always use their native search; other direct models omit `web_search`.

eve identifies a direct model's vendor by its AI SDK provider name. A `createOpenAI()` model pointed at an OpenAI-compatible endpoint, such as Amazon Bedrock's, therefore gets OpenAI web search. When the endpoint rejects it, eve retries the step without `web_search`, so each step makes one rejected call first. To avoid that, give the provider its own name, so the agent gets no `web_search`:

```ts title="agent/agent.ts"
import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const mantle = createOpenAI({
  name: "mantle",
  baseURL: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
  apiKey: process.env.BEDROCK_API_KEY,
});

export default defineAgent({ model: mantle("openai.gpt-5.6-sol") });
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

### `agent`

`agent` delegates a subtask to a fresh copy of the root agent. It is root-only, and each call is a [task](/docs/tools/tasks): the call returns a receipt, and the child's reply arrives later as the task's result. The child receives the root's instructions, tools, connections, and sandbox, but starts with fresh conversation history and [state](./state). See [Subagents](../subagents).

```sh
eve add tool/agent
```

```ts title="agent/tools/agent.ts"
export { default } from "eve/tools/agent";
```

To let the model choose an AI Gateway model for each root-copy task, export `agentWithModel` from the same slot:

```ts title="agent/tools/agent.ts"
export { agentWithModel as default } from "eve/tools/agent";
```

`agentWithModel` is a separate workflow tool that calls `ctx.agent("agent", { model })`; the default `agent` tool has no `model` parameter. It accepts:

```ts
{
  message: string;
  model: string; // AI Gateway model id for the child session
  taskId?: string;
}
```

It otherwise behaves like the default tool, and `taskId` continues the same root-copy session. The selected model applies to every turn in that session, so a continuation must repeat the original model; start a new task to use another. Because the parent model picks the value, use this tool only when it may choose any model your AI Gateway credentials and policies allow.

An authored `agent/tools/agent.ts` replaces the framework tool. Re-export the default definition, export `agentWithModel`, export another tool such as `agentRouter()`, or disable the slot. `agentRouter()` runs each call as a [task](/docs/tools/workflows#run-calls-as-tasks-task), which adds `eve__task_wait` and `eve__task_cancel`:

```ts title="agent/tools/agent.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

### `eve__search`, `eve__tool`, and `eve__skill`

The catalog tools let the model reach what isn't in its tool list. `eve__search` finds tools defined with `deferred: true`, agents defined with `tool: "deferred"`, every tool from the agent's [connections](../connections), and deferred [skills](../skills). `eve__tool` calls a deferred tool, agent, or connection tool by name, and `eve__skill` loads a skill, deferred or not. There is no add command; eve adds each one when the session has something it reaches, even when `defaultTools` is `false`:

- `eve__tool` comes with anything it can call: a deferred tool or agent, or a connection.
- `eve__skill` comes with any skill, so an agent whose only catalog entries are listed skills gets `eve__skill` alone.
- `eve__search` comes with anything it could find: whatever `eve__tool` can call, plus deferred skills.
- A session with none of these gets no catalog tools.

Declared entries count from the session's first step, and an entry a dynamic resolver returns counts from the step where it first appears. A resolver in `agent/tools/` that returns only non-deferred tools adds no catalog tools. Once a session has a catalog tool, it keeps it, even after a resolver stops returning the entry that brought it.

#### `eve__search`

`eve__search({ query, limit? })` returns the best matches, up to `limit` (default 10, at most 50). `query` is required and must contain a word. It isn't a regular expression, and eve ignores characters that can't appear in a name, such as a leading `^`.

| Match          | Fields                                                                                     | Use with     |
| -------------- | ------------------------------------------------------------------------------------------ | ------------ |
| Tool           | `tool` name, `description`, and a TypeScript `signature` rendered from its schemas         | `eve__tool`  |
| Deferred skill | `skill` name, `description`, and the `path` of its `SKILL.md` when it has supporting files | `eve__skill` |

A very long signature drops its property descriptions before any property name. Next to `results`, `searched` counts the entries the query covered, and `remaining` counts the matches past `limit`. A connection behind sign-in counts as its one sign-in result, and an unavailable connection counts as none.

Tools and skills rank together, in tiers:

1. An entry whose name is exactly the query.
2. An entry whose name after its last `__` is the query, such as `linear__create_issue` for `create_issue`.
3. The tools of a connection named by the query, so `eve__search({ query: "linear" })` lists the `linear` connection's tools first.
4. Entries whose names, or names after their last `__`, start with the query.
5. Keyword matches in names, parameters, and descriptions. One-letter and filler words such as `a` and `the` don't count unless the query has nothing else.

A query whose first word contains `__` searches one namespace: everything before its last `__`, without trailing underscores. `eve__search` keeps names under `<namespace>__` and anything named exactly the namespace, such as a connection's sign-in entry, then ranks them by the whole query. `eve__search({ query: "linear__" })` returns only the `linear` connection's tools, or its sign-in result. Connections that can't own names in that namespace don't appear in `unavailable`. A namespace that matches nothing fails with the closest connection names.

`eve__search` never asks the user to sign in. A connection whose server won't list its tools until sign-in appears as one result named after the connection, such as `linear`. A connection whose tools fail to load, or take longer than 10 seconds, appears under `unavailable`. Its `error` reads, for example, `"crm" did not list its tools within 10s. Try again later.` Matches from everything else still return. An `eve__tool` call on that connection's tools fails with the same error.

#### `eve__tool` and `eve__skill`

- `eve__tool({ name: "linear" })`, with a connection's own name, asks the user to sign in when the connection's tools need it. It returns once the tools can be listed, so the next `eve__search` finds them. If the server lists its tools without sign-in, it confirms they are available without asking.
- `eve__tool({ name, input? })` calls the entry named `name` with `input`, which defaults to `{}`. A connection tool's name is `<connection>__<tool>`, such as `linear__list_issues`. A call fails with the entry's signature when the input fails its schema, and with the closest names when the name is unknown. A skill's name fails with a reminder to use `eve__skill`. When the server asks for the user's authorization, the call asks the user to sign in and waits until sign-in completes.
- eve cancels a connection tool call that the server doesn't answer within 5 minutes. The call fails with an error such as `"linear" did not answer list_issues within 5 minutes. It may still have run, so check before you retry.` A tool that changes data may already have made the change.
- `eve__skill({ name })` loads the named skill, deferred or not, and returns its instructions. An unknown name fails with the closest skill names. A tool's name fails with a reminder to call it with `eve__tool` or directly. A connection's name says to find its tools with `eve__search({ query: "<connection>__" })`.

Once `eve__tool` or `eve__skill` resolves its entry, the call runs like a direct call. Approval policies, workflow tools and tasks, agents, `endsTurn`, `toModelOutput`, hooks, and stream events all see the entry's own name and input, such as `linear__list_issues`. Only model history records `eve__tool` or `eve__skill`. Loading a skill emits `call.requested` with `capability: { kind: "skill", name }`, then `call.settled`.

#### What the model is told

eve lists what the model can reach in an append-only context message, not the system prompt. The message lists:

- which kinds of deferred entries exist
- up to 20 namespaces, the first `__` segment of deferred names, such as `sre` for `sre__list_alerts`
- up to 20 connections with their descriptions

It never names a deferred entry, so deferred entries stay out of context until `eve__search` finds them. A later step appends the listing again only when it changes.

#### Reserved `eve` names

The tools eve adds itself live in the `eve` namespace: `eve__search`, `eve__tool`, `eve__skill`, `eve__task_wait`, `eve__task_cancel`, and `eve__reply`. No tool, subagent, skill, connection, or extension mount, static or dynamic, may be named `eve` or start with `eve__`. The compiler rejects an authored tool, skill, connection, or mount with such a name, such as `agent/tools/eve__search.ts`. eve rejects an authored subagent when the agent loads, and a dynamic entry when its resolver returns it. Any other name is free, including `search` and `execute`.

### `eve__task_wait` and `eve__task_cancel`

eve adds `eve__task_wait` and `eve__task_cancel` when the agent has a tool that runs its calls as [tasks](/docs/tools/tasks). These are the built-in `agent` tool, declared subagents, remote agents, `agentRouter()`, the `workflow` tool, and authored workflow tools that define `task(input, ctx)` or `serve(receive, ctx)`. There is no add command.

- `eve__task_wait({ timeoutSeconds? })` waits until any task has a result, a new message arrives, or `timeoutSeconds` pass. It returns at once when a result is already waiting. The turn stays running, not paused, because `turn.paused` only reports approvals, questions, and other requests for input. Results arrive in a `<task_result>` message right after it returns. Waiting never stops a task.
- `eve__task_cancel({ taskId })` stops a task's current work and says so. When the task already finished or is an idle [resumable task](/docs/tools/workflows#resumable-tasks-serve), it says the task had no work to stop. An id that names no task fails with `UNKNOWN_TASK`. Cancelling an agent task ends it; other resumable tasks stay available after a cancel.

Review these tools before production use. Disable, wrap, restrict, or require approval for any tool that can access the filesystem, network, shell, or sensitive data.

## Opt-in framework tools

These tools are not added by default. Add only the ones the agent needs, and remove the file to remove the tool; `disableTool()` is unnecessary.

### `ask_question`

`ask_question` lets the model ask the user one question, optionally with two or three options, and waits for the answer. [Human-in-the-loop](/docs/human-in-the-loop#questions) covers its input, results, and how channels show it. Add it:

```sh
eve add tool/ask_question
```

```ts title="agent/tools/ask_question.ts"
import { askQuestion } from "eve/tools/ask_question";

export default askQuestion;
```

`ask_question` is a [workflow tool](/docs/tools/workflows) that calls `ctx.ask()`. A steering message that doesn't answer the question withdraws it, and the model reads `{ interrupted: true }` as `Stopped early because a new message arrived.`, then the message. In a session that cannot request input, such as a [markdown schedule](/docs/schedules#markdown-form-fire-and-forget), the result is `{ status: "unavailable" }` and the model continues on its own judgment.

### `glob`

`glob` finds sandbox files by glob pattern. It searches the workspace root unless the model passes a directory, which accepts the same paths as `read_file`. Add it:

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

### `grep`

`grep` searches sandbox file contents with a regular expression. It searches the workspace root unless the model passes a directory or file inside the workspace. The code extension's `code__grep` tool behaves the same. Add it:

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

Inputs are `pattern`, optional `path`, `glob`, `ignoreCase`, `literal`, `context`, `limit`, and `outputMode`. Omit `outputMode` to list matching paths (`files_with_matches`); `content` returns matching lines and `count` returns per-file totals. Identifier-like patterns match literally unless `literal: false` is explicit. The default limit is 50 rows, capped at 200, with additional byte and line bounds.

Relative paths resolve against the workspace root; `$HOME` paths, parent traversal, and symlinks outside it are rejected. When the sandbox has ripgrep, results respect `.gitignore`; otherwise they don't. Results contain `content`, `matchCount`, `outputMode`, `path`, and `truncated`.

### `no_reply`

`no_reply` ends the turn without a reply. It fits a scheduled check that finds nothing to report, or an action the agent already took is the whole answer. The model calls it with an optional `{ reason }`, which stays in session history and traces and is never sent. Channels and schedule sends post nothing, and later turns see that the agent chose to stay quiet. Add it:

```sh
eve add tool/no_reply
```

```ts title="agent/tools/no_reply.ts"
import { noReply } from "eve/tools/no_reply";

export default noReply;
```

`no_reply` is a `defineTool` tool with [`endsTurn: true`](/docs/tools#end-the-turn-after-a-tool-call), so the turn ends only when no other tool runs in the same step. Only root sessions receive it. Slack clears the thread status when the turn completes.

Without `no_reply`, a root session also accepts an empty model reply with `finishReason: "stop"` and completes the turn without a final message. Use `no_reply` to record an explicit choice to stay quiet, with a reason. Delegated sessions retry an empty reply once and report a failure if it stays empty, so the caller can act on it.

### `sleep`

`sleep` pauses the current turn and resumes it later, without keeping the application runtime running. The wait survives restarts. The model calls it with `{ seconds }`. Concurrent calls run in parallel, and the turn resumes after the longest wait. A steering message, the default for a new message, ends the wait early: the model reads `{ interrupted: true }` as `Stopped early because a new message arrived.`, then the message. Add it:

```sh
eve add tool/sleep
```

```ts title="agent/tools/sleep.ts"
import { sleep } from "eve/tools/sleep";

export default sleep;
```

Customize it by wrapping the framework definition:

```ts title="agent/tools/sleep.ts"
import { defineWorkflowTool } from "eve/tools";
import { sleep } from "eve/tools/sleep";

export default defineWorkflowTool({
  ...sleep,
  description: "Pause before checking an external operation again.",
});
```

## What to read next

- [Tools](../tools): define your own tools, gate them on approval, and shape their output with `toModelOutput`
- [Dynamic capabilities](../guides/dynamic-capabilities): generate the tool set per session with `defineDynamic`
- [Sandbox](../sandbox): configure the sandbox used by shell and file tools
- [Subagents](../subagents): declare specialists that the model can delegate to
