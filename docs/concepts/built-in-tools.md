---
title: "Built-in Tools"
description: "The default and opt-in tools eve provides, including HarnessAgent, Workflow, glob, grep, and sleep."
---

eve provides a default tool set for every agent and additional framework tools you can add with one file. Use this page to review what the model can call, opt into more capabilities, or override and disable defaults. For custom tools, see [Tools](../tools).

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

- **`agent`** is available only in the root session. Its child uses the root's instructions, tools, connections, and sandbox, but starts with fresh conversation history and fresh [state](./state). The child receives neither `agent` nor `Workflow`; declared subagents do not receive the built-in `agent` either. See [Subagents](../subagents).
- **`load_skill`** only pulls instructions into context. It adds no new execution surface, because behavior still comes from the tools the agent already has.
- **`connection_search`** surfaces a connection's tools by their qualified name (e.g. `linear__list_issues`), which the model can then call directly. It's registered only when the agent has connections.
- **`web_search`** has no local executor; the provider runs it. AI Gateway models use Exa by default. To use Parallel instead, export `webSearch({ provider: "parallel" })` from `agent/tools/web_search.ts`. Direct provider models continue to use their native search implementation. To supply your own implementation, override it with `defineTool()`.

Review these default tools before production use. Disable, wrap, restrict, or require approval for any tool that can access the filesystem, network, shell, or sensitive data.

## Add framework-provided tools

Some framework-provided tools stay out of the default set. Add the corresponding file when your agent needs one:

| Tool            | Definition to export                               | Purpose                                            |
| --------------- | -------------------------------------------------- | -------------------------------------------------- |
| `glob`          | `defineGlobTool()` from `eve/tools`                | Find sandbox files by glob pattern.                |
| `grep`          | `defineGrepTool()` from `eve/tools`                | Search sandbox file contents by regex.             |
| `harness_agent` | `defineDynamicHarnessAgentTool()` from `eve/tools` | Run a coding harness in the current sandbox.       |
| `Workflow`      | `experimental_workflow()` from `eve/tools`         | Orchestrate root-agent copies from generated code. |
| `sleep`         | `sleep()` from `eve/tools/sleep`                   | Pause and durably resume the current turn.         |

For example, add file discovery and content search with two files:

```ts title="agent/tools/glob.ts"
import { defineGlobTool } from "eve/tools";

export default defineGlobTool();
```

```ts title="agent/tools/grep.ts"
import { defineGrepTool } from "eve/tools";

export default defineGrepTool();
```

The filename supplies the model-facing tool name. You can pass a custom `description` to either helper. The tools run against the agent's sandbox and use the same schemas, results, and error behavior as eve's framework implementations.

The sections below cover `harness_agent`, `Workflow`, and `sleep` in more detail.

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

Framework tool definitions are importable from `eve/tools/defaults` (`bash`, `readFile`, `writeFile`, `glob`, `grep`, `webFetch`, `todo`, `loadSkill`), so you can spread, wrap, or patch them. Importing a definition does not add it to an agent; export it from the corresponding `agent/tools/*.ts` file. Skip the spread and your replacement owns its own context. A fresh `defineTool` for `todo` won't inherit the framework's durable state key.

Provider-managed web search has a dedicated configuration helper instead of an executable default:

```ts title="agent/tools/web_search.ts"
import { webSearch } from "eve/tools";

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

- **Override** when you want the same capability with different behavior. Spread the default from `eve/tools/defaults` and wrap it (logging, an extra guard, a different backend), and the model still sees a tool by that name. Spreading keeps the default's description, schema, and any framework state, such as the `todo` tool's durable state key. Drop the spread and your replacement owns its own context, losing that wiring.
- **Disable** when the model should not have the capability at all. A `disableTool()` sentinel removes the built-in, and the model never sees it. Reach for this to lock down `bash` or `web_fetch` in an agent that should not run shell commands or fetch arbitrary URLs.
- **Author a new tool** when you want a capability the harness does not ship. Give it a fresh slug under `agent/tools/` and it joins the built-ins instead of replacing one. See [Tools](../tools) for the authoring model.

## HarnessAgent tool

The opt-in `harness_agent` tool runs Claude Code, Codex, or another supported coding harness against the agent's current sandbox. Each call starts a fresh HarnessAgent session, but it uses the same live `/workspace` and sandbox processes as the calling eve agent. Files written by the coding harness are immediately visible to the caller.

Export the flexible definition from a file named `harness_agent.ts`:

```ts title="agent/tools/harness_agent.ts"
import { defineDynamicHarnessAgentTool } from "eve/tools";

export default defineDynamicHarnessAgentTool();
```

Pass `description` to replace the default model-facing tool description.

The model supplies `task` and `harness`. It can also supply `model`, `id`, `instructions`, `skills`, and a workspace-relative `workingDirectory`. Supported harness names are `claude-code`, `cline`, `codex`, `deepagents`, `grok-build`, `opencode`, and `pi`. Omitting `model` uses the selected harness's default model.

Every `harness_agent` call requires eve tool approval before it starts. Once approved, the selected coding harness runs its built-in tools without additional approval prompts. The HarnessAgent tool does not expose inner tool approval, permission mode, tool filtering, timeout, or debug settings.

### Preconfigure a HarnessAgent tool

Use `defineFixedHarnessAgentTool` when instructions and other settings belong in code rather than model input. The resulting tool exposes only `task` and `harness` to the model:

```ts title="agent/tools/implement_change.ts"
import { defineFixedHarnessAgentTool } from "eve/tools";

export default defineFixedHarnessAgentTool({
  description: "Implement a requested change in the repository.",
  instructions: "Implement the requested change and run the relevant checks.",
  harnesses: ["claude-code", "codex"],
  models: {
    "claude-code": "your-claude-model",
  },
  workingDirectory: "my-repo-checkout",
});
```

`description` is required because each preconfigured tool has a specific purpose. Set `harnesses` to an allowlist or to `"all"`; omitting it enables all supported harnesses. `models` is the only per-harness configuration. Each omitted model continues to use that harness's default.

The general settings are `id`, `instructions`, `skills`, and `workingDirectory`. A skill has `name`, `description`, and `content`, plus optional `files` entries with `path` and `content`.

### Return structured output

Only a preconfigured HarnessAgent tool can declare structured output because an eve tool has one output schema for every invocation. Pass a Zod schema as `outputSchema`; eve exposes it as the tool's output schema and requires the coding harness to produce the same shape:

```ts title="agent/tools/review_change.ts"
import { defineFixedHarnessAgentTool } from "eve/tools";
import { z } from "zod";

const reviewSchema = z.object({
  verdict: z.enum(["approved", "neutral", "changes-required"]),
  summary: z.string(),
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.string().optional(),
      message: z.string(),
      severity: z.enum(["low", "medium", "high"]),
    }),
  ),
});

export default defineFixedHarnessAgentTool({
  description:
    "Request a code review of the current diff in the repository, including structured findings.",
  harnesses: ["claude-code", "codex", "grok-build"],
  instructions:
    "Review the current code changes diff. Provide a final verdict and any findings that require iteration or should be reconsidered.",
  outputSchema: reviewSchema,
  workingDirectory: "my-repo-checkout",
});
```

The tool returns the validated object directly. Without `outputSchema`, both HarnessAgent tool shapes return the harness's final text.

### Sandbox requirements

Claude Code, Codex, DeepAgents, Grok Build, and OpenCode use an in-sandbox bridge. Configure the `vercel()` sandbox backend with at least one exposed port for the bridge:

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

export default defineSandbox({
  backend: vercel({ ports: [4319] }),
});
```

The HarnessAgent tool reserves an available port from the configured `ports` array and passes that port and its `wss://` Vercel Sandbox URL to the selected harness adapter. The tool does not add or remove Vercel Sandbox routes. Configure more than one port if the agent can run bridge-backed harness calls concurrently.

Cline and Pi do not use a bridge and can run with another eve sandbox backend. All harnesses still work in the caller's current sandbox; the tool never creates a second sandbox. The first call for a bridge-backed harness may need outbound network access while its adapter bootstraps the bridge inside the sandbox.

Authentication is not a HarnessAgent tool setting. Each adapter resolves its usual credentials from the eve runtime environment, such as `AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`, or its provider-specific API key, and makes the required credentials available to the harness process.

## Workflow tool

The opt-in experimental `Workflow` tool lets the model write JavaScript that coordinates the agent's own subagents as a single durable step. The program can run them in sequence, feed one result into the next, fan out over a list, and combine the results. You enable the capability and the model decides and runs the orchestration.

A single turn can already call several subagents, and parallel tool calls dispatch concurrently. What a workflow adds is _programmatic_ coordination. The program decides how many subagents to run based on an earlier result, which output feeds which call, and how to combine everything. That is logic the model cannot express as a few one-off calls.

`Workflow` is a model-facing tool, not an API for authored tools, hooks, or application code. Authored code cannot submit a Workflow program or use `Workflow` to start an arbitrary user-authored Vercel Workflow. Use the [client SDK](../guides/client/overview) when application code needs to start or continue an eve session; use ordinary application APIs for other deterministic orchestration.

### Enable Workflow

Export the experimental Workflow definition from `agent/tools/workflow.ts`. The helper name carries the "experimental" warning, but the tool the model actually sees is named `Workflow`.

```ts title="agent/tools/workflow.ts"
import { experimental_workflow } from "eve/tools";

export default experimental_workflow();
```

Without that file, the `Workflow` tool stays off. It earns its keep only when the agent has subagents (or the built-in `agent`) worth coordinating:

```ts title="agent/subagents/analyst/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  description: "Analyzes one metric: queries, computes, writes a short finding.",
  model: "anthropic/claude-opus-4.8",
});
```

When asked for a weekly business review, the model picks the metrics, runs one `analyst` per metric in parallel, and combines the findings. The program below is the kind of JavaScript the model authors. It fans `analyst` out over a runtime-decided list of metrics and merges the results:

```js
const metrics = ["revenue", "signups", "churn"];
const findings = await Promise.all(
  metrics.map((metric) => tools.analyst({ message: `Summarize last week's ${metric}.` })),
);
return findings.join("\n\n");
```

Each `tools.analyst(...)` call dispatches a child subagent, so the parent stream records one `subagent.called` per metric and one `subagent.completed` as each finishes:

```json
{ "type": "subagent.called", "data": { "name": "analyst", "toolName": "analyst", "callId": "call_1", "childSessionId": "ses_a1", "sequence": 0 } }
{ "type": "subagent.called", "data": { "name": "analyst", "toolName": "analyst", "callId": "call_2", "childSessionId": "ses_a2", "sequence": 1 } }
{ "type": "subagent.called", "data": { "name": "analyst", "toolName": "analyst", "callId": "call_3", "childSessionId": "ses_a3", "sequence": 2 } }
{ "type": "subagent.completed", "data": { "subagentName": "analyst", "callId": "call_1", "output": "..." } }
{ "type": "subagent.completed", "data": { "subagentName": "analyst", "callId": "call_2", "output": "..." } }
{ "type": "subagent.completed", "data": { "subagentName": "analyst", "callId": "call_3", "output": "..." } }
```

### What a workflow can orchestrate

A workflow reaches only this agent's own agents: the built-in `agent` (a copy of itself), declared [subagents](../subagents), and [remote agents](../guides/remote-agents). That is the whole list. No files, network, shell, skills, or connections. A workflow is a coordination layer over subagents, not a place to do other work. Each call can still request structured output via `outputSchema`, exactly like a direct subagent delegation.

### Caps on workflow-spawned subagents

Workflow orchestration is capped in two independent ways.

**Per-program call budget.** One Workflow program may dispatch at most `maxSubagents` subagent calls in total, counted across the whole program — sequential and parallel calls alike. Configure it on `experimental_workflow`; the default is 100. Calls beyond the budget do not start a child session; they resolve inside the program with a `WORKFLOW_SUBAGENT_LIMIT_REACHED` error result, and the budget is stated in the tool's description so the model sizes its fan-out to fit.

```ts title="agent/tools/workflow.ts"
import { experimental_workflow } from "eve/tools";

export default experimental_workflow({ maxSubagents: 4 });
```

**Root-only orchestration.** Only the root session receives `Workflow`. Children started by a workflow receive neither `Workflow` nor the built-in `agent`, so Workflow programs cannot recurse. A declared child can still call subagents defined in its own directory (see [Subagents](../subagents)).

### Where the JavaScript runs

The orchestration code never touches the agent's process. The runtime hands the program text to a small isolated JavaScript engine (a QuickJS sandbox) and runs it there. Nothing from the host realm crosses in, so there is no `process`, no `globalThis` from the agent, and no `import`/`require`. The program can reach exactly two things, the agent functions bridged in as `tools.<name>` and the ordinary language built-ins.

That is an allowlist, not a denylist. The sandbox cannot read files, open a socket, or see an environment variable because those are not present, not because each one is blocked in turn. When the program calls an agent function, that call bridges back out to the runtime, which dispatches it exactly like a direct delegation. The orchestration glue stays inside the sandbox.

### Durability, approvals, and observability

- **Durable.** The whole orchestration counts as one step. Subagents dispatched together run concurrently, and if a run parks (suspends durably without holding compute; see [Execution model and durability](./execution-model-and-durability)) on a long-running or human-gated child, it resumes where it left off after a restart.
- **Approval-safe.** A subagent that needs human approval (HITL, human-in-the-loop) mid-run surfaces its request to the user, and the workflow picks back up once that is answered, same as direct delegation.
- **Observable.** Every orchestrated subagent emits the usual `subagent.called` / `subagent.completed` events on the parent stream and gets its own child session and stream. The telemetry matches direct delegation, so existing dashboards and cost attribution keep working.

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
- [Subagents](../subagents): declare the agents that `agent` and `Workflow` can call
