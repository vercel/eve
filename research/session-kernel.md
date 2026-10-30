---
issue: "None (maintainer-requested research)"
status: proposed
last_updated: "2026-10-30"
---

# eve in layers: a sealed kernel, harnesses, and hosts

## Summary

eve is built for long-running sessions that involve more than one person. People share a conversation, approvals and sign-ins wait for days, and every channel and client reads the same event stream. The stream's facts carry guarantees. For example, a call that needs approval can't run until someone allowed to answer approves it.

This plan splits eve into layers so those guarantees hold whatever loop runs and wherever the session runs:

- A sealed **kernel** becomes the only code that writes facts and the only path by which a call runs.
- A **harness** tells the kernel what the next model call gets and what the turn does next. eve's own loop becomes one harness.
- A **host** runs the session: Workflow when deployed, or one process for an agent embedded in a CLI, a worker, or a test.

None of this is part of 1.0. The kernel and harness split is drafted in stack #5638, #5566, #5604, #5609, #5621, and #5640, and this document uses its names. Anything the stack doesn't have is marked proposed, including the flat harness shape; the stack groups the model, instructions, and tools under `agent`. Code here is pseudocode.

## What eve guarantees

A multi-party session has to track who said what, who may approve what, which requests wait on whom, and what happened to every call. eve records all of it as facts, which clients, channels, hooks, and the kernel fold into one view. An approval shows how much depends on them:

```mermaid
flowchart TD
  Requested["call.requested"] --> Gate{"approval policy"}
  Gate -- allowed --> Started["call.started"]
  Gate -- needs a person --> Opened["interaction.opened<br/>turn.paused"]
  Gate -- denied --> Rejected["call.settled: rejected"]
  Opened --> Answered["interaction.settled"]
  Answered -- declined --> Rejected
  Answered -- accepted --> Recheck{"policy and input<br/>checked again"}
  Recheck -- allowed --> Started
  Recheck -- denied --> Rejected
  Started --> Settled["call.settled"]
```

A client that shows "waiting for approval" relies on `call.started` never coming first. A channel that posts an approval card relies on one answer settling the whole batch. Whoever approves, the call runs as the person whose turn made it, so approving doesn't lend the approver's credentials.

Much of this is enforced today. The gate decides every call the model makes, and the stream checker (`protocol/session-events/checker.ts`) checks lifecycle rules on every line in tests and under `eve dev`. But no single component owns the guarantee:

- Guard rule 51, which limits which modules build lifecycle facts, documents its own gaps.
- A few facts outside `harness/` are built by hand, and one path writes to the stream without the checker.
- The checker has no rule that ties a call's start to its approval.

Nothing is known to break the contract. It holds because separate pieces of code agree, not because one owner enforces it.

The contract covers effects that go through eve. It isn't a defense against a malicious tool or host, which can reach a service directly. Provider-executed tools, such as a provider's web search, run inside the model call where eve can't gate them, so offering one is the decision to allow it. Sandboxes and scoped credentials limit what an approved call can reach. They complement the gate; they don't replace it.

## The layers

This is the proposed layering. The kernel section covers where today's code differs.

```mermaid
flowchart TD
  Authoring["Authoring<br/>agent/ files or code"] -- resolved agent --> Runtime
  Runtime["Session runtime<br/>admission, answers, controls, tasks, hooks"] -- inputs --> Kernel
  Harness["Harness: replaceable<br/>model, instructions, tools, history, next"] -- policy --> Kernel
  Kernel["Kernel: sealed<br/>machine, commit, step"] -- facts --> Protocol["Protocol<br/>facts, progress, fold, selectors"]
  Kernel -- lines --> Host["Host<br/>inbox, timers, storage, durable runs"]
  Host -- next input --> Runtime
```

- **Session runtime** works between steps. It submits inputs to the kernel and doesn't write facts.
- **Harness** is policy. It returns data the kernel applies.
- **Kernel** owns the guarantees. Its machine turns the session's view and an input into facts, its commit orders and checks them, and its step calls the model and runs calls through the gate.
- **Host** is what the runtime waits on and writes to. Durable runs for workflow tools, tasks, and child sessions exist only where the host provides them.

Hooks and `ctx.continue()` (#5555) belong to the runtime: a hook is an effect after a commit. `next` decides how a turn ends; `ctx.continue()` decides whether another begins.

## The kernel

### A step

A step runs from the harness choosing the model to the harness deciding what's next:

```mermaid
flowchart TD
  Model["next: model"] --> Evaluate["evaluate model, instructions, tools, history"]
  Evaluate --> Provider["provider call through the AI SDK"]
  Provider --> Text["text: content facts"]
  Provider --> Calls["tool calls"]
  Calls --> Gate{"gate"}
  Gate -- allowed --> Adapter["execution adapter<br/>function, sandbox, or durable run"]
  Gate -- needs a person --> Park["interaction.opened, park"]
  Gate -- denied --> History["results join history"]
  Adapter --> History
  Text --> Next["next"]
  History --> Next
```

The AI SDK turns the provider's response into text, tool calls, and usage. The kernel turns each tool call into a governed call: it resolves the tool, validates the input, applies approval and authorization, and then runs or parks the call. Choosing `model` includes that dispatch, so a harness doesn't repeat it. Inspecting calls before they run would need a separate, explicit capability.

The kernel decides whether a call runs, and an execution adapter decides how. A call runs as a function in the step, as an operation in the session's sandbox, or as a durable run the host starts for a workflow tool, task, or child session. A durable run reports back as input, and the kernel settles the call. No adapter bypasses the gate.

Sandboxes and connections are execution environments that the host provides and tools use. An approval covers the operation a tool declares, not everything the operation can reach, so approving `bash` grants whatever the sandbox allows.

### What no harness can change

- Every call, the model's or the harness's, passes the gate. A harness can't skip, answer, or forge an approval or a sign-in.
- A call runs as the person whose turn made it.
- A turn doesn't settle while its tasks work. The kernel waits for them and calls the model with their results.
- Input that arrives during a turn is read in that turn.
- After a model step, `model` needs something unread: tool results or a nonblank note. A turn gets at most three notes, and then eve's own decision applies.
- Usage limits apply before every model call and every batch of harness calls. Every model call is billed, including the summarizer's and `decide()`'s (#5638).
- History changes are checked: each tool result follows its call once, no call loses its result, a summary opens the history, the running turn's input stays, and the history fits the model's window.
- A settled output must match the turn's output schema.
- A harness that throws or returns something invalid fails the turn with "The agent's harness failed." The reason goes only to the logs.

### One author for facts

Today the session machine (`harness/session-machine/`) builds most facts, but not all of them, and not every fact reaches the stream the same way:

```mermaid
flowchart LR
  Turn["turn steps"] --> Machine["session machine<br/>and fact helpers"]
  Other["controls, tasks, relays,<br/>session end"] --> Machine
  Machine --> Publisher["publish-session-events.ts<br/>close, position, check, hooks, write"]
  Hand["delivery admit and ignore,<br/>session.started, child.opened, child.sent"] -- built by hand --> Publisher
  Publisher --> Stream[("session stream")]
  Stranded["end-stranded-session.ts"] -- unchecked --> Stream
```

Proposed, the machine builds every fact, and the publisher splits by owner. The kernel's commit closes, positions, and checks lines, the host writes them, and the runtime runs hooks:

```mermaid
flowchart LR
  subgraph Kernel["kernel"]
    Step["step<br/>model and tools"] --> Machine["machine<br/>view + input → facts"]
    Machine --> Commit["commit<br/>order, close, check"]
  end
  Inputs["deliveries, controls, run messages,<br/>relays, session end"] --> Machine
  Commit -- lines --> Host["host writer"]
  Host --> Stream[("session stream, unchanged")]
  Stream -.-> Hooks["runtime runs hooks"]
  Hooks -. new inputs .-> Inputs
```

The hand-built facts become machine transitions, the stranded-session end goes through the commit, and rule 51 extends to the whole package. The one exemption is `execution/v26-history.ts`, which translates streams recorded before v27 as they're read and never writes. The stream format doesn't change.

Relays already work this way. A child session or a workflow run sends its parent relay messages whose events look like facts. The parent's `relay()` transition treats them as input: it ignores repeats and events for interactions it doesn't mirror, sets the subject and origin itself, and builds its own facts. Neither the relay message nor the stream changes. A relayed interaction carries an `origin`, which tells it apart from the parent's own approvals.

The machine and the commit need only the session's view, not a loaded agent. Some facts are written exactly when an agent can't be built: a session's end, a terminal failure, or a session stranded by an upgrade. `createKernel`, which builds a step from one agent's model, tools, and harness, sits on top of the machine. The authority lives below it.

### How the kernel is checked

Among other rules, the stream checker already enforces:

- introduction before reference;
- one terminal fact per entity;
- closed outcome sets;
- closure when an owner ends;
- one open turn;
- pauses that wait on a person;
- approval batches that settle together.

It runs in the writer during tests and under `eve dev`, so a mistake fails where it's made.

The proposed addition is authorization. A `call.started` for a call with its own approval request must follow that request's accepted `interaction.settled`, and its `clearedBy` must name the request. To prove the rule, a test that skips the gate on purpose must fail the checker. Harness calls emit the same facts, so the rule covers them too.

Guard rule 58 keeps Workflow out of `harness/`, so the step can run with a fake model and no Workflow world. The machine's transitions are pure, so they're tested directly.

## Harnesses

### The shape

```ts title="agent/harness.ts"
import { defineHarness } from "eve/experimental/harness";

export default defineHarness((ctx) => ({ model, instructions, tools, history, next }));
```

The function runs synchronously and only says what each field is. A field is a value or a function, and the kernel calls a function only when it needs the value. A missing field, or one that returns `undefined`, falls back to eve's. The flat shape is proposed.

| Field          | What it returns                                          | When the kernel evaluates it                                               |
| -------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `model`        | Which model, with its options                            | Before each model call                                                     |
| `instructions` | The whole system prompt                                  | Before each model call                                                     |
| `tools`        | Every tool the model is offered                          | Before each model call                                                     |
| `history`      | What the model remembers, saved as the session's history | Before each model call, and on `session.compact()`                         |
| `next`         | What the turn does next                                  | At turn start, after each model step, and after the harness's calls settle |

`model`, `instructions`, and `tools` apply to one call. `history` persists.

### `next`

```ts
type Next =
  | { model: { note?: string } } // call the model, after showing it the note
  | { calls: { tool: string; input?: JsonValue }[] } // call tools, then decide again
  | { settle: { output: JsonValue | null } } // end the turn with this reply
  | { fail: { message: string } }; // end the turn as failed
```

A harness's `calls` pass the same gate as the model's. Approvals, sign-ins, and workflow and task tools park the same way, and history records the calls as the agent's. Today a harness can call only the tools the step offers the model. Calling the agent's other tools is proposed.

When a harness decides the reply, the model's text streams as a draft until the turn settles. Channels such as Slack post only the reply, so a critic can reject a draft before any channel posts it.

### `model`, `instructions`, and `tools`

`model` accepts anything `agent.ts`'s `model` does: a model id, a model instance, or a selection such as `{ model, modelOptions, reasoning }`. Provider options travel with the selection.

`instructions` is the whole system prompt: a string, or an array whose non-empty entries are joined. The kernel adds only its own recovery note, at the start, when it retried without a tool the provider rejected. The prompt cache breakpoint is at the end of the system prompt, so text that changes from call to call costs the cache wherever it sits.

`tools` is exactly the set the model is offered. Leaving out one of eve's tools turns off its feature:

- Without `eve__skill`, skills can't load.
- Without `eve__task_wait`, the model can't wait on tasks, though the turn still does.
- Without `eve__reply`, the model can't return structured output, so the harness settles the turn.

Two helpers provide the parts:

- **`declared(ctx)`** is what the agent's files declare, as data: `instructions` with their roles, `skills` (`name`, `description`, `deferred`, `load()`), `tools`, `workspace`, and `model`. Default tools such as `bash` count as declared, because a file can replace or turn off each one.
- **`builtins(ctx)`** is what eve adds: the `eve__` tools, and renderers for eve's prompt sections. The renderers cover `skills`, `workspace`, `tools`, `tasks`, and `instructions`, which composes the whole default prompt.

### `history`

The stream records what happened, and history is what the model remembers. `history` returns the full array, and the kernel compares it with the current history:

- If nothing changed, nothing is recorded.
- If only unread messages changed, the change joins the append.
- If read messages changed, the kernel checks the new history and records a rewrite.

Compaction is one history policy. Trimming large tool results and dropping irrelevant turns are others. The kernel knows the model's context window, a physical limit, and reports the next call's size as `ctx.size`. The compaction threshold is policy, so it lives in eve's harness.

`ctx.summarize(history)` is eve's summarizer, and its model call is announced and billed. The kernel doesn't react to providers' context-overflow errors, which have no common shape, so the harness compacts before the call. The kernel checks a new history's structure, not whether a summary is faithful.

### What a harness reads

| Field                                      | Meaning                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `ctx.history`                              | The model history as of this decision                                                   |
| `ctx.calls`                                | The turn's calls: tool, input, status, outcome, and output when small enough            |
| `ctx.lastStep`                             | The latest model step: `text`, `output`, and `endsTurn`                                 |
| `ctx.steps`, `ctx.continuations`           | Model calls this turn, and the notes the harness added                                  |
| `ctx.size`, `ctx.compact`, `ctx.summarize` | The next call's tokens and the window; a `session.compact()` request; eve's summarizer  |
| `ctx.memo`                                 | A cache across evaluations. A crash or a deploy can rerun it, so it isn't an effect log |
| `ctx.session`                              | The session's id, identity, and metadata                                                |
| `ctx.input`                                | Proposed: the message that opened the turn                                              |
| `ctx.unread`                               | Proposed: history ends with tool results the model hasn't read                          |
| `ctx.signal`                               | Proposed: the turn's abort signal                                                       |

### eve's harness

This is eve's entire default harness:

```ts
export const native = defineHarness((ctx) => ({
  model: async () => (await declared(ctx)).model,
  instructions: async () => builtins(ctx).prompt.instructions(await declared(ctx)),
  tools: async () => ({ ...(await declared(ctx)).tools, ...builtins(ctx).tools }),

  history: () =>
    ctx.compact || ctx.size.tokens > threshold(ctx.size) // `compaction.threshold` from agent.ts
      ? ctx.summarize(ctx.history)
      : ctx.history,

  next: () => {
    const last = ctx.lastStep;
    if (last === undefined) return { model: {} }; // turn start
    if (last.output !== undefined) return { settle: { output: last.output } };
    if (ctx.unread && !last.endsTurn) return { model: {} }; // results the model hasn't read
    return { settle: { output: last.endsTurn ? null : last.text } };
  },
}));
```

Parking for approvals, reading queued input, and waiting for tasks are kernel rules, so they don't appear here.

### What you can build

Each example is a complete `agent/harness.ts`, and some use the proposed `ctx` fields. Fields an example leaves out are eve's. Small helpers such as `textOf`, `size`, and `preview` aren't shown.

<details>
<summary><strong>Skills your way:</strong> keep one skill always loaded, and list the rest in your own words.</summary>

```ts title="agent/harness.ts"
import { declared, defineHarness } from "eve/experimental/harness";

export default defineHarness((ctx) => ({
  instructions: async () => {
    const files = await declared(ctx);
    const refunds = files.skills.find((skill) => skill.name === "refunds");
    const others = files.skills.filter((skill) => skill !== refunds && !skill.deferred);

    return [
      "You are Acme's billing assistant.",
      files.instructions.agent.content,
      await refunds?.load(),
      "Load these with eve__skill({ name }) when a request needs one:\n" +
        others.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
    ];
  },
}));
```

eve's skills section mixes data (names and descriptions), mechanism (load with `eve__skill`), and policy ("activate the minimal set"). With skills as data, the author owns all three.

</details>

<details>
<summary><strong>Large tool results:</strong> keep a preview in history while the full output stays on the stream.</summary>

```ts title="agent/harness.ts"
import { defineHarness } from "eve/experimental/harness";

const LIMIT = 20_000;

export default defineHarness((ctx) => ({
  history: () =>
    ctx.history.map((message) =>
      message.role !== "tool"
        ? message
        : {
            ...message,
            content: message.content.map((part) =>
              size(part.output) > LIMIT ? { ...part, output: preview(part.output, LIMIT) } : part,
            ),
          },
    ),
}));
```

A trimmed result is already under `LIMIT`, so only the newest result changes. The kernel folds that change into the append, which means no rewrite and no prompt-cache miss. Clients still show the full output from `call.settled`.

</details>

<details>
<summary><strong>Compaction on your terms:</strong> compact earlier, with your own summary instructions.</summary>

```ts title="agent/harness.ts"
import { defineHarness } from "eve/experimental/harness";

export default defineHarness((ctx) => ({
  history: () => {
    const { tokens, window = Infinity } = ctx.size ?? { tokens: 0 };
    if (!ctx.compact && tokens <= 0.5 * window) return ctx.history;

    // Proposed options; `ctx.summarize` takes only `tokens` today.
    return ctx.summarize(ctx.history, {
      keepTurns: 4,
      model: "openai/gpt-6-luna",
      instructions: "Keep ticket IDs, decisions with their reasons, and open questions.",
    });
  },
}));
```

The summarizer's call is announced as a compaction and billed to the session. If the result still doesn't fit, the turn fails; eve doesn't fall back to its own compaction.

</details>

<details>
<summary><strong>Critic:</strong> check the draft before the turn settles, and send it back with a note.</summary>

```ts title="agent/harness.ts"
import { decide } from "eve/ai";
import { defineHarness } from "eve/experimental/harness";

export default defineHarness((ctx) => ({
  next: async () => {
    const draft = ctx.lastStep?.text;
    if (!draft || ctx.unread || ctx.continuations >= 2) return undefined;

    const { answers } = await decide({
      state: { request: textOf(ctx.input), draft },
      questions: {
        cited: {
          type: "boolean",
          instructions: "Does every factual claim in the draft cite a source?",
        },
      },
      signal: ctx.signal,
    });

    return answers.cited.probability >= 0.5
      ? undefined
      : { model: { note: "Some claims have no source. Cite one for each, or remove the claim." } };
  },
}));
```

The rejected draft stays in history before the note, so the model revises with both in view, and channels never post it. The `decide()` call is billed to the turn. To escalate instead of revising, also return a stronger `model` once `ctx.continuations > 0`.

</details>

<details>
<summary><strong>Command turn:</strong> run <code>/deploy staging</code> without calling the model.</summary>

```ts title="agent/harness.ts"
import { defineHarness } from "eve/experimental/harness";

export default defineHarness((ctx) => ({
  next: () => {
    const target = /^\/deploy (\w+)$/.exec(textOf(ctx.input))?.[1];
    if (target === undefined) return undefined;

    const deploy = ctx.calls.find((call) => call.tool === "deploy");
    if (deploy === undefined) return { calls: [{ tool: "deploy", input: { target } }] };
    if (deploy.outcome !== "completed") {
      return { fail: { message: `The ${target} deploy was ${deploy.outcome}.` } };
    }
    return { settle: { output: `Deployed ${target}: ${deploy.output.url}` } };
  },
}));
```

The call still passes the gate. If `deploy` needs approval, the turn waits, and a denial settles the call as `rejected`. Other messages fall through to eve's loop.

</details>

<details>
<summary><strong>Workspace-scoped agent:</strong> fail early for suspended workspaces, and fit tools to the plan.</summary>

```ts title="agent/harness.ts"
import { builtins, declared, defineHarness } from "eve/experimental/harness";
import { loadWorkspace } from "./lib/workspaces";

export default defineHarness((ctx) => {
  const id = ctx.session.auth.current?.attributes.workspaceId;
  const workspace = () => ctx.memo(`workspace:${id}`, () => loadWorkspace(id));

  return {
    next: async () => {
      if (ctx.lastStep !== undefined) return undefined;
      const { suspended } = await workspace();
      return suspended ? { fail: { message: "This workspace is suspended." } } : undefined;
    },

    tools: async () => {
      const { tools } = await declared(ctx);
      const { deploy, bash, ...rest } = tools;
      const { plan } = await workspace();
      return { ...(plan === "enterprise" ? tools : rest), ...builtins(ctx).tools };
    },

    instructions: async () =>
      [
        builtins(ctx).prompt.instructions(await declared(ctx)),
        `This workspace is on the ${(await workspace()).plan} plan.`,
      ].flat(),
  };
});
```

One cached lookup drives three decisions. The harness adds eve's tools back, because a harness that sets `tools` offers exactly what it returns.

</details>

## Hosts and embedded eve

### What a session needs

Channels, schedules, and routes need the compiler and the `agent/` layout. The kernel and the session's semantics don't. The compiler already accepts programmatic sources, modules at logical paths, which framework defaults and the in-memory test compiler use. An agent defined in code goes through that path, so it gets the compiler's validation and errors, and names still come from paths.

The kernel alone can't run a session. Routing an answer to its call, admitting a message mid-turn, binding identity, applying cancel and compact, and recovering an interrupted step all live in the session runtime. A prototype that drove the kernel directly had to rebuild that glue, and it got answer routing wrong. An embedded session reuses the session runtime.

```mermaid
flowchart TD
  Files["agent/ files"] --> Compiler["compiler"]
  Code["agent defined in code"] --> Compiler
  Compiler --> Agent["resolved agent"]
  Handle["Session handle<br/>eve/sessions"] --> Runtime{"Runtime"}
  Runtime --> Workflow["createWorkflowRuntime"]
  Runtime --> Process["in-process Runtime<br/>proposed"]
  Workflow --> Loop["one session loop, given a host"]
  Process --> Loop
  Agent --> Loop
  Loop --> Kernel["harness and kernel"]
```

`Session` from `eve/sessions` already talks to a `Runtime` interface, and `createWorkflowRuntime` is its only implementation. An in-process `Runtime` would be a second implementation behind the same handle, so a UI written against one works with the other.

### What a host provides

Today the session loop (`runSessionLoop`) and step (`turnStep`) are written against Workflow. They wait on Workflow hooks, arm Workflow sleeps, and read step metadata. Proposed, the loop gets these from a host, and the Workflow reads move into a thin adapter around a shared step:

```ts
// Proposed.
interface SessionHost {
  inbox: SessionInboxReader; // the next input; claims the session's addresses
  timers: { until(deadline: Date): Promise<void> };
  owns(runId: string): boolean; // ignores a timer or prewarm an earlier owner armed
  moves?: SessionMoves; // moving the session between runs
  runs?: DurableRuns; // workflow tools, tasks, child sessions
}
```

The loop's rules don't change: controls that arrive before the session starts, prewarming, and how cancel, clear, and compact settle. Those rules keep an embedded session identical to a deployed one. With the publisher split, the host also writes committed lines and reads back what an interrupted attempt wrote.

|                                      | Workflow host                     | In-process host                                     |
| ------------------------------------ | --------------------------------- | --------------------------------------------------- |
| Input                                | Workflow hooks                    | An in-memory queue                                  |
| Timers                               | Durable `sleep`                   | The process's timers                                |
| Storage                              | The run's stream and step results | A store the embedder passes, or memory              |
| Workflow tools, tasks, and subagents | Workflow runs                     | Not provided; calls fail with an error that says so |
| Moving between deployments           | Handoff                           | Not needed                                          |
| Sessions that outlive the process    | Yes                               | Only with a store                                   |

The in-process store would use the format handoff already uses, `SessionCheckpoint` and its migrations, so either host can read a session the other saved. Step inputs and outputs would round-trip through Workflow's serializer, so a value that can't cross a Workflow step fails in process too.

Integration tests that don't depend on Workflow would be the first users. Running the same scenarios through both hosts and comparing streams and prompts would show the hosts agree. The scenarios cover a batch with one approval and one denial, a follow-up turn, cancel, compact, clear, and a restart from the store.

A host could also store a deployed session as a checkpoint plus records instead of replaying a Workflow run, which would end version pinning. That's a separate proposal.

### A terminal agent in one file

This sketch uses the proposed `createSession` to build a local terminal agent. It has eve's `bash`, `read_file`, and `write_file` tools in an in-process just-bash sandbox, and it asks for approvals inline:

```ts title="terminal.ts"
import { createInterface } from "node:readline/promises";

import { createSession } from "eve/experimental/embed"; // proposed
import { JustBashSandbox } from "eve/sandbox/just-bash";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { bash } from "eve/tools/bash";
import { readFile } from "eve/tools/read_file";
import { writeFile } from "eve/tools/write_file";

const session = createSession({
  model: "anthropic/claude-sonnet-5",
  instructions: "You are a concise coding assistant.",
  tools: {
    bash,
    read_file: readFile,
    write_file: defineTool({ ...writeFile, approval: always() }),
  },
  sandbox: JustBashSandbox.environment({}),
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt: string) => (process.stdout.write(prompt), (await lines.next()).value);
rl.on("SIGINT", () => void session.cancel());

for (let line; (line = await ask("> ")) !== undefined;) {
  let delivery = await session.send(line);
  while (delivery !== undefined) {
    for await (const event of delivery.stream()) {
      if (event.type === "content.delta") process.stdout.write(event.data.delta);
      if (event.type === "call.requested") console.log(`\n⚙ ${event.data.capability.name}`);
    }
    const open = (await delivery.result()).interactions.filter((i) => i.status === "open");
    if (open.length === 0) break;

    const answers = [];
    for (const interaction of open) {
      const yes = /^y/i.test((await ask(`approve ${interaction.call?.name}? [y/n] `)) ?? "");
      answers.push({
        interactionId: interaction.interactionId,
        optionId: yes ? "approve" : "deny",
      });
    }
    delivery = await session.respond(answers);
  }
  process.stdout.write("\n");
}
```

`createSession` compiles the definition as a programmatic agent and returns a `Session` over an in-process `Runtime`, with the host's user as the default identity. `send`, `respond`, `cancel`, and `compact` work as they do on a deployed session. The tools, gate, facts, fold, and loop are the ones a deployed agent uses. So `bash` runs at once, `write_file` waits for approval, and `result().interactions` comes from the same selectors a deployed client reads.

The same handle could back a web chat in a small worker. The worker still needs routes for its client, server-side authentication for its users, and a callback URL for sign-ins. Approvals wait as long as the process lives, or across restarts with a store.

## Later: exposing it

The draft stack already exports `defineHarness`, `declared(ctx)`, and `builtins(ctx)` from `eve/experimental/harness`. The rest could become public in steps after 1.0, each one experimental first:

- **`agent/harness.ts`** default-exports `defineHarness((ctx) => ({ model, instructions, tools, history, next }))`. Authors can adopt one field at a time.
- **Composition is a function call.** To combine eve's compaction with its own trimming, a harness calls eve's exported pieces inside its own `history`. There's no processor pipeline.
- **`compaction` options in `agent.ts`** keep configuring eve's harness. A harness that defines `history` owns compaction.
- **`eve/experimental/embed`** exports `createSession`. It takes an agent defined in code, plus an optional store, identity, and sandbox, and returns a `Session`.
- **A host interface** for other stores, queues, and timers could follow once the Workflow and in-process hosts have proven it.
- **The kernel stays sealed:** both its rules and its authorship of every fact.

Before any of it becomes stable, it needs an updated research doc, docs pages, e2e evals for each `next` value and its failure modes, and a changeset.
