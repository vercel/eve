---
title: "Agents in Code"
description: "Define an agent with defineAgent and run its sessions in your own process."
---

`eve/experimental/embed` runs an agent defined in code inside your program: no `agent/` directory, no build, no server. A session has the same loop, approvals, history and event stream as a deployed agent. This API is experimental, and its names and shapes will change.

## Define an agent and talk to it

```ts title="release.ts"
import { createSession, defineAgent, defineContext, localUser } from "eve/experimental/embed";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

const deploy = defineTool({
  description: "Deploy the current branch to an environment.",
  inputSchema: { type: "object", properties: { env: { type: "string" } }, required: ["env"] },
  approval: always(),
  execute: async ({ env }) => ({ deployed: true, env }),
});

const release = defineAgent({
  name: "release",
  model: "anthropic/claude-haiku-4.5",
  instructions: "You are a terse release manager.",
  tools: { deploy },
  definitions: [defineContext("time", () => `It is ${new Date().toISOString()}.`)],
});

// Who the session acts as: here the person at this machine. A server passes the caller it authenticated.
const session = createSession(release, { identity: localUser() });
const delivery = await session.send("Ship it to staging.");
for await (const event of delivery.stream()) {
  if (event.type === "content.delta") process.stdout.write(event.data.delta);
}
// Approvals are open interactions; answer them with `session.respond([...])`.
const { interactions } = await delivery.result();
await session.close();
```

`defineAgent` is the function `agent/agent.ts` uses, from `eve` or this entry, and [Agent Configuration](../agent-config#fields-for-agents-defined-in-code) lists the fields an agent in code takes. Tools, skills and instructions are the values the stable entries make (`eve/tools`, `eve/skills`, `eve/instructions`). `defineContext(name, content)` adds text to every model call, just ahead of the turn's input; pass it in `definitions`.

`identity` has no default. `localUser()` is the user this process runs as, for a script or CLI on that user's machine. `null` is no one in particular.

A session has:

| Member                     | What it does                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `send(message)`            | Sends a message. The delivery streams the turn it starts or joins.                             |
| `respond(answers)`         | Answers open requests, such as approvals.                                                      |
| `cancel()`                 | Cancels the running turn.                                                                      |
| `pending()`                | What the session waits on a person for.                                                        |
| `events({ from, signal })` | The session's events from line `from`, as they're written.                                     |
| `snapshot()`               | The session as JSON-safe data that `createSession(agent, { restore })` continues.              |
| `suspend()`                | Stops the session here without ending it. Its World keeps it, with its sandbox files and runs. |
| `close()`                  | Ends the session: its turn and subagents end, and its sandbox is released.                     |

## Default tools and sandboxes

An agent in code starts with no built-in tools. `eve.defaults()` lists eve's default tools with a sandbox for them:

```ts
import { defineAgent, eve, hostSandbox } from "eve/experimental/embed";
import { always } from "eve/tools/approval";

const coder = defineAgent({
  name: "coder",
  model: "anthropic/claude-sonnet-4.5",
  definitions: eve.defaults({
    sandbox: hostSandbox({ confine: true }),
    without: ["web_search"],
    approval: { bash: always(), write_file: always() },
  }),
});
```

- `memorySandbox()` runs the shell and file tools in memory (just-bash), so nothing touches the disk. In Node its files last as long as the process.
- `hostSandbox()` runs them in the process's working directory, with no isolation, so gate `bash` and `write_file` with approvals. `confine: true` keeps file tools and working directories inside it; a command's own arguments aren't checked.
- `codeSandbox(environment)` wraps any other sandbox environment, such as `DockerSandbox.environment()` from `eve/sandbox/docker`. Its template is prepared on first use, once per process.

## Keep sessions

A session is a run on a World, which keeps it as it runs: each message before it's accepted, each line of its stream as it's written, and the rest at every step. By default that World is in your process's memory. `localWorld({ dataDir })` keeps sessions in a directory with Workflow's local World, and `vercelWorld()` in a Vercel project's World (the one `vercel link` linked the directory to, with a token from `VERCEL_TOKEN` or `vercel login`), so another process, on this machine or another, continues them: pass it as `createSession(agent, { identity, world })`, and continue a session with `resume`. `listSessions(world)` lists them, most recently saved first.

```ts
import { createSession, listSessions, localUser, localWorld } from "eve/experimental/embed";

const world = localWorld({ dataDir: ".sessions" });
const [latest] = await listSessions(world);
const session = createSession(coder, { identity: localUser(), world, resume: latest?.id });
```

Resumed, a turn a crash cut off goes on from its last step, and the model reads which of its calls may have run. `suspend()` leaves a session to resume; `close()` ends it. `snapshot()` returns the session as data, which `createSession(agent, { restore })` continues on any World.

## Terminal UI

`eve/experimental/embed/terminal` serves an agent to the `eve dev` terminal UI, in the same process. With a World, each session is kept as it runs, and `resume` continues one by id, including a turn a crash cut off:

```ts
import { localWorld } from "eve/experimental/embed";
import { runTerminal } from "eve/experimental/embed/terminal";

const world = localWorld({ dataDir: ".sessions" });
await runTerminal(coder, { name: "coder", world, resume: process.argv[2] });
```

In the UI, `/info` lists the agent's tools, sandbox and definitions, and `/help` lists the commands. Setup commands such as `/model` and `/deploy` are for `eve dev`'s app and aren't offered.

## Limits

- Sessions run in your process, one writer per session. Give them a World (`localWorld()`), or save a snapshot, to keep them. For durability across instances, build the agent from files and deploy it.
- Tasks, workflow tools and subagents run in this process. After a crash, a subagent's run goes on from the World that kept its session; any other run that was in flight is reported to its parent as interrupted.
- Schedules, remote agents and the agent-wide `approval` aren't supported in code yet.
