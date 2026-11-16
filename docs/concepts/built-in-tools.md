---
title: "Built-in Tools"
description: "The default and opt-in tools eve provides, including bash, file tools, glob, grep, and sleep."
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

Add back only the tools the agent needs with the command in each tool's section. Files under `agent/tools/` stay available, including same-name replacements such as `agent/tools/bash.ts`. `defaultTools` doesn't affect [the catalog tools](#eve__search-eve__tool-and-eve__skill), which eve adds from what the session can reach, or [`eve__execute`](#eve__execute), which `codeMode` adds.

### `bash`

`bash` runs shell commands in the agent's [sandbox](../sandbox).

```sh
eve add tool/bash
```

```ts title="agent/tools/bash.ts"
export { default } from "eve/tools/bash";
```

`bash` waits up to 60 seconds for a command. The model can pass `timeout` to wait longer for a build or test suite, up to 120 seconds. Values above 120 wait 120, and values below 1 wait 1. The cap leaves room for the model call within the Vercel Functions time limit. A command that finishes in time returns `status: "completed"` with `exitCode`, `stdout`, `stderr`, and `truncated`. A command that is still running keeps running in the sandbox as its own process group and returns `status: "running"` with:

- `pid`: the process group id
- `outputDirectory`: a directory under `/tmp/.eve/jobs/`
- `stdout`, `stderr`, and `truncated`: the output so far
- `message`: instructions for the model

The model reads the result as plain text: `stdout`, then any `stderr` after a `[stderr]` line, or `(no output)` when the command printed nothing. Each stream keeps its last 2,000 lines or 50 KB. A line longer than 2,000 characters keeps its start and ends with `[truncated]`. A stream with lines left out starts with a note, which names a file in the sandbox holding the full output when the sandbox runs `bash` with its job files (`just-bash` does not). A command that exits non-zero ends with `[exit code: N]` and reaches the model as an error result. For a running command, `message` follows the output instead. Channels and hooks get the fields above on `call.settled`.

The command writes to `stdout` and `stderr` files in `outputDirectory`, and its exit code to an `exit` file when it finishes. The model checks on or stops it with shell commands in later `bash` calls, so the tool's approval policy applies to them:

```sh
tail /tmp/.eve/jobs/3f9a1c2e/stdout   # latest output
cat /tmp/.eve/jobs/3f9a1c2e/exit      # exit code, once the command has finished
kill -- -4312                         # stop the command's whole process group
```

The command runs across turns until it exits, the model stops it, or the sandbox stops, and its output files last until the sandbox stops. Cancelling a turn stops a command that hasn't yet returned `running`. A message that arrives while `bash` waits reaches the model after the call returns, so a longer `timeout` can delay it. The `just-bash` provider has no background processes, so it runs every command to completion.

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

A wrapper that spreads `bash` keeps its `timeout` input. If the wrapper supplies its own `execute` or input schema, forward `timeout` to `bash.execute` or remove it from the schema.

The wrapper also keeps the plain-text view through the spread `toModelOutput`. If your `execute` returns a string, the model sees that text. Any other shape, including a `bash` result with extra fields, reaches the model as JSON; set your own [`toModelOutput`](../tools#shape-what-the-model-sees-with-tomodeloutput) to change that.

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

`edit_file` also changes existing files. If you disable or wrap `write_file` to limit writes, do the same for `edit_file`.

### `edit_file`

`edit_file` edits one sandbox file by exact text replacement. To add it back after `defaultTools: false`:

```sh
eve add tool/edit_file
```

```ts title="agent/tools/edit_file.ts"
export { default } from "eve/tools/edit_file";
```

The model passes `path` and `edits`, a list of `{ oldText, newText }` replacements. Each `oldText` must match exactly one region of the file as it was before the call, and replacements must not overlap. When no exact match exists, `edit_file` ignores trailing whitespace and treats smart quotes, Unicode dashes, and special spaces as their ASCII forms. The file keeps its byte order mark, and every line gets the file's first line ending, so a CRLF file stays CRLF. `edit_file` rejects files that are not valid UTF-8.

Relative paths resolve against the workspace root, and `~` or `$HOME` resolves to the sandbox's home directory. `edit_file` doesn't require a `read_file` call first. After it changes a file the session already read, `write_file` can overwrite that file without another `read_file` call. A failed edit changes nothing, and its error names the problem, such as a missing or ambiguous `oldText`. The model reads `Successfully replaced N block(s) in <path>.`, and channels and hooks get `{ path, replacements }` on `call.settled`.

Customize it by wrapping the framework definition:

```ts title="agent/tools/edit_file.ts"
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { editFile } from "eve/tools/edit_file";

export default defineTool({ ...editFile, approval: always() });
```

Disable it:

```ts title="agent/tools/edit_file.ts"
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

Select Tako Search to search the web and Tako's knowledge graph of structured data in one call:

```ts title="agent/tools/web_search.ts"
import { webSearch } from "eve/tools/web_search";

export default webSearch({ provider: "tako" });
```

Results include web pages and Tako data cards. Each card names its sources and links an embeddable chart. The model chooses the search effort and whether to return a card's rows in the result. Deep searches and card rows cost more than a fast search, so say in your agent instructions when to use them. Tako Search requires a [Gateway model ID](../agent-config#set-the-model). AI Gateway runs the search with its usual credentials, so no Tako API key is needed. See [Tako Search on AI Gateway](https://vercel.com/docs/ai-gateway/models-and-providers/web-search#using-tako-search).

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

Set `fallback` to give models without native search a provider that works with any Gateway model (`"exa"`, `"parallel"`, `"browserbase"`, or `"tako"`):

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

To let the model run a root-copy task on another model, call `agent({ models })` and list the models it may choose:

```ts title="agent/tools/agent.ts"
import { agent } from "eve/tools/agent";
import { anthropic } from "@ai-sdk/anthropic";

export default agent({
  models: {
    "openai/gpt-6-sol": "Difficult reasoning and engineering tasks",
    "openai/gpt-6-luna": "Routine tasks where fast completion matters",
    haiku: {
      model: anthropic("claude-haiku-5"),
      description: "Cheap lookups and short summaries",
      reasoning: "low",
    },
  },
});
```

`models` takes the same entries as [`auto()`](../guides/decide#choose-from-gateway-models). A string entry is the description, and its key is the AI Gateway model ID. An object entry holds the model, an AI Gateway model ID or an AI SDK model, with its description and optional `reasoning`, `modelContextWindowTokens`, and `modelOptions`. The tool then accepts:

```ts
{
  message: string;
  model?: "openai/gpt-6-sol" | "openai/gpt-6-luna" | "haiku"; // one of the keys
  taskId?: string;
}
```

The model sees each key with its description and can choose only those keys. A call without `model` runs on the root agent's model, the same as the default tool; with a dynamic model such as `auto()`, the copy chooses again. `agent()` with no `models` is the default tool, with no `model` input. The selected model applies to every turn of the task's session. A continuation can omit `model` or repeat the original one; start a new task to use another. Copies and declared subagents never get this tool.

An authored `agent/tools/agent.ts` replaces the framework tool. Re-export the default definition, export `agent({ models })`, export another tool such as `agentRouter()`, or disable the slot. `agentRouter()` runs each call as a [task](/docs/tools/workflows#run-calls-as-tasks-task), which adds `eve__task_wait` and `eve__task_cancel`:

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

It never names a deferred entry, so deferred entries stay out of context until `eve__search` finds them. A later step appends the listing again only when it changes. With [`codeMode`](#eve__execute) on, the message also tells the model to call several tools from `eve__execute` as `tools.<name>(input)`.

#### Reserved `eve` names

The tools eve adds itself live in the `eve` namespace: `eve__search`, `eve__tool`, `eve__skill`, `eve__execute`, `eve__task_wait`, `eve__task_cancel`, and `eve__reply`. No tool, subagent, skill, connection, or extension mount, static or dynamic, may be named `eve` or start with `eve__`. The compiler rejects an authored tool, skill, connection, or mount with such a name, such as `agent/tools/eve__search.ts`. eve rejects an authored subagent when the agent loads, and a dynamic entry when its resolver returns it. Any other name is free, including `search` and `execute`.

### `eve__execute`

`eve__execute` is code mode. The model writes a JavaScript program that calls the agent's tools and returns one value. Only that value and a summary of the calls enter the conversation, so the data the program reads along the way stays out of context. Turn it on for an agent that chains, loops over, filters, or combines many tool calls.

There is no add command. Set `codeMode: true` in `agent.ts`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.4",
  codeMode: true, // omit to leave eve__execute out
});
```

- `codeMode` applies to the agent that sets it, root or subagent. A copy of the root from the `agent` tool follows the root.
- The setting is fixed at build time. A [dynamic subagent configuration](/docs/subagents#conditional-availability) that returns it fails with `The "codeMode" field cannot be selected at runtime.`
- `defaultTools: false` doesn't remove `eve__execute`.
- Activity shows the call as `Run code`, then `Ran code, <n> calls`.

The model calls `eve__execute({ code })`. `code` is the body of an async function, so `await` and `return` work at the top level. This program emails each new lead through a tool that asks for approval:

```js
const { leads } = await tools.crm__list_leads({ status: "new" });
// Start the sends together, so every approval is asked at once.
const sends = await Promise.allSettled(
  leads.map((lead) => tools.send_email({ to: lead.email, template: "welcome" })),
);
console.log(`${leads.length} new leads`);
return leads.map((lead, i) => ({ email: lead.email, sent: sends[i].status === "fulfilled" }));
```

A program has three globals:

| Global                      | What it does                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.<name>(input)`       | Calls a tool, agent, or connection tool by its exact name and resolves to its output. `input` defaults to `{}`. Write `tools["name"]` when the name isn't a JavaScript identifier. |
| `search({ query, limit? })` | Returns what [`eve__search`](#eve__search) returns for the same input.                                                                                                             |
| `console`                   | Lines from `log`, `info`, `warn`, `error`, and `debug` go back to the model as `logs`.                                                                                             |

- A program has no `fetch`, file system, timers, or imports. It runs in an isolated JavaScript runtime in your app, not in the agent's [sandbox](../sandbox).
- A call resolves to the tool's own return value, not its [`toModelOutput`](/docs/tools#shape-what-the-model-sees-with-tomodeloutput) version. Give tools an `outputSchema` so the model [knows each result's type](/docs/tools#declare-output-types-for-code-mode).
- A failed or denied call throws at its `await`, so the program can catch the error and continue.
- A program that returns while a call is still pending fails, so await every call, including ones passed to `Promise.race`.
- Each input and the return value pass through `JSON.stringify`. A program that returns nothing returns `null`.

#### What a program can call

A program calls entries by the same names the model uses, whether they are in the tool list or deferred:

| Entry                                                                                            | From a program                                            |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Deferred tools, connection tools, and a connection's sign-in entry                               | Yes                                                       |
| Tools in the model's tool list that eve runs, such as `bash` and `read_file`                     | Yes                                                       |
| `execute` and `task` [workflow tools](/docs/tools/workflows), such as `ask_question` and `sleep` | Yes. A `task` tool resolves to its result, not a receipt. |
| Agents with `tool` omitted or `"deferred"`                                                       | Yes. See [Agents in programs](#agents-in-programs).       |
| `eve__*` tools                                                                                   | No. `search()` takes the place of `eve__search`.          |
| Tools eve doesn't run, such as provider-managed `web_search`                                     | No                                                        |
| Tools with [`endsTurn`](/docs/tools#end-the-turn-after-a-tool-call)                              | No                                                        |
| `serve` workflow tools that aren't agents                                                        | No                                                        |
| A [`workflow()`](#workflow) tool                                                                 | No. The program calls the agents itself.                  |
| Agents with `tool: false`                                                                        | No                                                        |

A call the program can't make throws one of these errors. An unknown name lists the closest tool names when it has any:

```text
No tool named "<name>". Find tools with search({ query }).
"eve__search" can't be called from a program; use search({ query }).
"<name>" is in your tool list; call it directly.
"<name>" ends your turn, so a program can't call it; call it directly.
"<name>" keeps a task open between calls, which a program can't hold; call it directly.
"<name>" runs a program in the background, which a program can't start. Call the agents from this program as tools.<agent>({ message }), or call "<name>" directly.
```

A call whose input fails the tool's schema throws the issue and the tool's signature.

#### Agents in programs

A program awaits an agent's answer. The call doesn't start a [task](/docs/tools/tasks):

```js
const review = await tools.reviewer({
  message: `Review this deployment plan:\n\n${plan}`, // everything the agent needs
  // optional JSON Schema: the call then resolves to a matching value
  outputSchema: {
    type: "object",
    properties: { approved: { type: "boolean" }, reason: { type: "string" } },
    required: ["approved", "reason"],
  },
});
```

- Without `outputSchema`, the call resolves to the agent's reply text.
- Each call starts a new child session. A call with `taskId` throws, so a program can't continue an earlier child.
- An [`agent({ models })`](#agent) tool also accepts `model`.
- The child sessions belong to the `eve__execute` call. They aren't tasks, so `eve__task_wait` and `eve__task_cancel` don't see them.
- A failed child turn throws at its call.
- A program can't call an agent with `tool: false`. Set [`tool: "deferred"`](/docs/subagents#declared-subagents) to keep an agent out of the tool list while programs call it.

#### What the model reads back

When the program returns, the model reads `{ result, logs?, calls, notCompleted? }`. When the program fails, the tool result is an error with `error` in place of `result`. The lead program above returns this when a person approves Alice's email and denies Bob's:

```json
{
  "result": [
    { "email": "alice@example.com", "sent": true },
    { "email": "bob@example.com", "sent": false }
  ],
  "logs": ["2 new leads"],
  "calls": { "completed": 2, "rejected": 1 },
  "notCompleted": [
    {
      "tool": "send_email",
      "outcome": "rejected",
      "input": "{\"to\":\"bob@example.com\",\"template\":\"welcome\"}"
    }
  ]
}
```

| Field          | What it holds                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result`       | The program's return value.                                                                                                                                         |
| `error`        | The uncaught error's message, with the line that threw. When a call completed first, it ends with `Calls that completed before this are not undone.`                |
| `logs`         | The program's console lines, when it wrote any.                                                                                                                     |
| `calls`        | How many `tools` calls ended each way: `completed`, `failed`, `rejected`, `interrupted`, or `abandoned`. `search()` calls aren't counted.                           |
| `notCompleted` | The first 20 calls that didn't complete, whether or not the program caught them. Each has its `tool`, its `outcome`, and its `input` as JSON cut to 500 characters. |

A `rejected` call was denied by a policy or a person, or its approval was withdrawn. An `interrupted` call didn't finish because the program stopped. An `abandoned` call was cut off by a [crash](./execution-model-and-durability#programs-after-a-crash).

A result over 10,000 estimated tokens reaches the model as its head and tail, with a note to return less. Model history holds only the `eve__execute` call and this result. The stream reports [each call the program makes](./sessions-runs-and-streaming#streamed-output) under its own name.

#### Calls that wait

Calls that can finish right away run as the program makes them, up to 32 at a time. A call that has to wait pauses the program: a person's approval, a sign-in, a workflow tool, an agent, or a question. A paused program holds no compute and survives restarts. It resumes when every call it paused on has a result, and calls that already finished don't run again.

- **Approvals.** Each call goes through its own tool's `approval` and the agent-wide policy, and `eve__execute` itself never asks. See [Approve calls from a program](/docs/human-in-the-loop#approve-calls-from-a-program).
- **New messages.** A steering message, the default for a new message, stops a running or paused program. Finished calls keep their results, and no new call starts. The model reads `{ error: "Stopped early because a new message arrived.", calls, notCompleted? }`, then the message.
- **Cancellation.** Cancelling the turn cancels the `eve__execute` call and everything it started.
- **Crashes.** The program runs again as the same call, and finished calls return their recorded results. See [Programs after a crash](./execution-model-and-durability#programs-after-a-crash).

#### Program limits

The limits are fixed. An error over a limit names it, such as `EXECUTE_CALL_LIMIT_REACHED: a program may make at most 1024 calls; "linear__get_issue" was not called.`

| Limit                                                    | Value                   | Over the limit                                                                      |
| -------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| Calls per program, `tools` calls and searches together   | 1,024                   | The call throws `EXECUTE_CALL_LIMIT_REACHED`.                                       |
| Agent calls per program                                  | 128                     | The call throws `EXECUTE_AGENT_LIMIT_REACHED`.                                      |
| Calls running at once                                    | 32                      | Later calls wait their turn. Calls the program paused on don't count.               |
| JavaScript time, each time the program starts or resumes | 30 seconds              | The program fails with `EXECUTE_CPU_LIMIT_REACHED`. Waiting on calls isn't counted. |
| Total time, each time the program starts or resumes      | 5 minutes               | The program fails with `EXECUTE_TIME_LIMIT_REACHED`. Paused time isn't counted.     |
| Program source                                           | 256 KiB                 | The program fails with `EXECUTE_SOURCE_TOO_LARGE`.                                  |
| One call's input, or the return value, as JSON           | 1 MiB                   | The call throws, or the program fails, with `EXECUTE_VALUE_TOO_LARGE`.              |
| One call's output as JSON                                | 4 MiB                   | The call throws `EXECUTE_OUTPUT_TOO_LARGE`.                                         |
| Results a paused program holds                           | 8 MiB                   | The program fails with `EXECUTE_CONTINUATION_LIMIT_REACHED`.                        |
| Memory and stack                                         | 64 MiB and 2 MiB        | The program fails.                                                                  |
| Console output                                           | 64 KiB                  | Later lines are dropped.                                                            |
| Result the model reads                                   | 10,000 estimated tokens | The model reads the head and tail.                                                  |

#### Run a program in the background

An `eve__execute` program holds the turn until it returns. To let the model keep working while agents run, add the [`workflow()` tool](#workflow). It runs the same kind of program in the background, as a [task](/docs/tools/tasks). The two differ in where the program runs and what follows from that:

|                         | `eve__execute`                                                                                                              | `workflow()` tool                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| How you add it          | `codeMode: true` in `agent.ts`                                                                                              | A tool file that exports `workflow()`              |
| What `tools` reaches    | The agent's tools, connection tools, and agents. See [What a program can call](#what-a-program-can-call).                   | Agents only, including agents with `tool: false`   |
| How it runs             | Inside the turn, as one tool call                                                                                           | Outside the session, as a task in a run of its own |
| A new message           | Stops the program                                                                                                           | Doesn't stop it                                    |
| Where the result goes   | The `eve__execute` tool result                                                                                              | A receipt at once, then a `task.result` message    |
| Agent calls per program | 128                                                                                                                         | `maxSubagents`, which is 128 unless you lower it   |
| Approval of agent calls | Gated by the agent-wide [approval policy](/docs/human-in-the-loop#approve-calls-from-a-program), like the model's own calls | Not gated. A local child's own tool calls are.     |

A `workflow()` program runs outside the session, so its `tools` holds agents only. It has no session sandbox, sign-ins, or remembered approvals to run other tools with.

Use `eve__execute` when the model needs the result in this turn. Use the `workflow()` tool when the model should keep working while agents run. The two combine:

- A `workflow()` program fans out to agents, and an agent with `codeMode` on can use `eve__execute` for its own tool calls.
- An `eve__execute` program calls agents itself when the model needs their answers in this turn. It can't start a `workflow()` program.

### `eve__task_wait` and `eve__task_cancel`

eve adds `eve__task_wait` and `eve__task_cancel` when the agent has a tool that runs its calls as [tasks](/docs/tools/tasks). These are the built-in `agent` tool, declared subagents, remote agents, `agentRouter()`, the [`workflow()` tool](#workflow), and authored workflow tools that define `task(input, ctx)` or `serve(receive, ctx)`. There is no add command.

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

`grep` searches sandbox file contents with a regular expression. It searches the workspace root unless the model passes a directory or file inside the workspace. Add it:

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

`no_reply` is a `defineTool` tool with [`endsTurn: true`](/docs/tools#end-the-turn-after-a-tool-call), so the turn ends once it succeeds, after any other tool calls in the same step settle. Only root sessions receive it. Slack clears the thread status when the turn completes.

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

### `workflow`

The `workflow()` tool runs a JavaScript program the model writes, in the background. The program calls agents and returns one value. It runs as a [task](/docs/tools/tasks): the model gets a receipt, keeps working, and reads the result later in a `task.result` message. It is the background counterpart of code mode. See [Run a program in the background](#run-a-program-in-the-background) for how the two differ.

There is no add command. Create the file:

```ts title="agent/tools/workflow.ts"
import { workflow } from "eve/tools/workflow";

// maxSubagents: agent calls per program, from 1 through 128. Omit it for 128.
export default workflow({ maxSubagents: 20 });
```

- The file name is the tool's name. The tool works with or without `codeMode`.
- A `workflow()` tool isn't an authored [workflow tool](/docs/tools/workflows). `defineWorkflowTool` runs a workflow you write, and `workflow()` runs a program the model writes.

The model calls `workflow({ code })`. `code` is the body of an async function, as it is for [`eve__execute`](#eve__execute). This program starts three `researcher` sessions side by side, then gives their findings to a second agent:

```js
const areas = ["billing", "auth", "search"];
// Start the calls together, so the agents work side by side.
const findings = await Promise.all(
  areas.map((area) => tools.researcher({ message: `List the open incidents in ${area}.` })),
);
console.log(`researched ${areas.length} areas`);
return await tools["incident-writer"]({
  message: `Summarize these findings:\n\n${findings.join("\n\n")}`,
  // optional JSON Schema: the call then resolves to a matching value
  outputSchema: {
    type: "object",
    properties: { title: { type: "string" }, urgent: { type: "number" } },
    required: ["title", "urgent"],
  },
});
```

- `tools.<name>({ message, outputSchema? })` sends `message` to a new session with that agent. The call resolves to the agent's reply text, or to the structured value when `outputSchema` is set.
- `<name>` is a name [`ctx.agent`](/docs/tools/workflows#delegate-work-ctxagent) accepts, such as a subagent's path-derived name. Write `tools["name"]` when the name isn't a JavaScript identifier.
- A program can call an agent hidden with `tool: false` or a same-named `disableTool()` file. Name those agents in the agent's instructions, because the model's tool list doesn't show them.
- Each call starts a new child session, which doesn't see the conversation. A call with any property other than `message` and `outputSchema`, such as `taskId`, throws.
- `tools` holds agents only. `search()` throws, and a program has no other tools, `fetch`, file system, timers, or imports.
- A failed child turn, an invalid call, or a call over `maxSubagents` throws a `ToolError` at that call, which the program can catch. A call over the limit reads `EXECUTE_AGENT_LIMIT_REACHED: a program may call agents at most 20 times; "researcher" was not called.`

When the program returns, the task's result is `{ result, logs?, calls }`: the return value, the console lines, and how many agent calls ended as `completed` or `failed`. An [`eve__execute` result](#what-the-model-reads-back) has the same three fields.

A program that throws, or that returns while a call is still pending, fails its task. The failure message holds the error, the program line that threw, and the console output. When a call completed first, the message says so:

```text
Error: no recipients left (line 3) Calls that completed before this are not undone.
console output:
sent one
```

A `workflow()` program has the source, time, size, memory, and console limits of an `eve__execute` program; see [Program limits](#program-limits). Only `maxSubagents` is a setting.

The program's task follows the [task rules](/docs/tools/tasks). The model waits for it with `eve__task_wait` and stops it with `eve__task_cancel`, and the turn can't end while it works.

In the child sessions, agent authorization, questions, approvals, and cancellation work as they do for a session an authored workflow tool opens with [`ctx.agent`](/docs/tools/workflows#delegate-work-ctxagent). The parent stream announces each child session with `child.opened`. Its `owner` is `{ callId }` naming the `workflow` call, so a client can show the children under that call.

## What to read next

- [Tools](../tools): define your own tools, gate them on approval, and shape their output with `toModelOutput`
- [Dynamic capabilities](../guides/dynamic-capabilities): generate the tool set per session with `defineDynamic`
- [Sandbox](../sandbox): configure the sandbox used by shell and file tools
- [Subagents](../subagents): declare specialists that the model can delegate to
