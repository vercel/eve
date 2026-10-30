---
issue: "None (maintainer-requested research)"
status: proposed
last_updated: "2026-10-31"
---

# Session kernel and harness

## Summary

eve's turn loop decides two kinds of things at once. Some are guarantees every agent needs: approvals, identity, usage accounting, the integrity of model history, and the lifecycle facts that clients read. Others are policy: whether to call the model again, what the model reads about the past, and which tools and instructions it gets. On main both live in the same functions, so each new behavior adds a branch to the loop or a callback around it.

This plan splits the loop into a sealed **kernel**, which owns the guarantees and is the only code that emits facts, and a replaceable **harness**, a function that returns policy as data: `{ agent, history, next }`. eve's current behavior becomes the native harness, written in the same shape an author would use.

The session runtime around the loop has a different problem: it is written against Workflow. A session is one Workflow run, and the `Session` handle that channels, schedules, and route code use reaches it through a `Runtime` interface with a single implementation. Giving the session loop a **host**, and adding a second, in-process `Runtime`, makes an **embedded eve**: an agent defined in code, with eve's tools, gate, facts, and `Session` handle, running in one process with no compiler output and no Workflow world. The same seam is where a deployed runtime could later keep sessions in a store instead of replaying them, which would end version pinning.

The plan covers internal refactors that change no observable behavior, in two groups: the kernel and harness, then the session runtime. It ends with what could follow after 1.0: a store instead of replay, and public APIs for both groups. Nothing here is part of 1.0. A draft of the kernel and harness refactors is GitHub stack #5702, #5638 through #5640, and names here follow it. Fields, options, and functions it doesn't have yet are marked as proposed. Code in this document is pseudocode, and signatures are simplified.

## The layers eve should have

```text
app              compiler · agent/ files · routes · channels · dev UI
session runtime  admission · inbox · answers · tasks · timers · hooks    ─┐
harness          { agent, history, next }                  replaceable    │ runs on
kernel           model calls · gate · tool calls · history ·              │ a host
                 usage · lifecycle facts                   sealed         │
protocol         facts · progress · fold · view · selectors              ─┘
host             input · timers · storage · durable runs   Workflow today; in-process next
```

- **Protocol** is the session's record: facts, which are authoritative; progress, which previews work in flight; the fold that turns them into a view; and selectors that read the view. Clients, channels, hooks, and the kernel read the same fold.
- **Kernel** runs one step of a session. It calls the model, passes every tool call through the gate (approval, sign-in, authorization), runs the call, writes history, records usage, enforces limits, and publishes the facts that describe all of it. Only the kernel emits facts.
- **Harness** is policy, computed from the session: what the next model call gets (`agent`), what the model reads about the past (`history`), and what the turn does next (`next`). It returns data, and the kernel applies it.
- **Session runtime** is everything between steps: admitting deliveries, queueing input, routing answers, running tasks and subagents, timers, and hooks, which run after a commit.
- **Host** is what the session runtime waits on and writes to: an inbox for input, timers, storage for the session's lines and values, and, where it can, durable runs for workflow tools, tasks, and child sessions. Today the only host is Workflow, which also moves sessions between runs when they need new code or a shorter event log.
- **App** is the compiler and the `agent/` layout, routes, channels, and the dev UI.

Definitions such as tools, approval policies, models, connections, and skills are shared by every layer.

## How main is factored

The protocol is already its own layer. `protocol/session-events` defines facts and progress, `protocol/session-projection` folds them, and clients and the loop read the same view. The kernel, the harness, and parts of the runtime are not separated:

```text
app              compiler · agent/ files · routes · channels
session runtime  execution/session/*, workflow-runtime.ts  written against Workflow
loop             harness/kernel.ts, step/{intake,after-model,park},
                 compaction/step.ts, reactions/kinds/*     policy and guarantees together
protocol         protocol/session-events, protocol/session-projection
```

Five places show the cost.

**Whether the turn continues** is one boolean in `harness/step/after-model.ts`, next to the code that writes history and settles the turn:

```ts
const continueLoop =
  (!calledFinalOutput || finalOutputRejected) &&
  ((responseTail.at(-1)?.role === "tool" && !endsTurn) ||
    normalizedProviderHistory.outcomeEndsResponse ||
    hasQueuedTurnInput(step.view()));
```

Policy, such as calling the model again after tool results, sits beside rules no agent may change, such as reading input that arrived during the turn and never settling while tasks work. A critic, a command that answers without the model, or a check that fails the turn has to land here, or in a new callback around it.

**What the model reads about the past** changes in several places: after each model step, during compaction, and when history is repaired. Compaction is its own stage with its own trigger, `shouldCompact` against `compaction.threshold`, and its own options in `agent.ts`. A different strategy needs a new option or a new hook.

**Which tools, instructions, and model a call gets** comes from reactions under `reactions/kinds/` (tools, instructions, model, skills, memory, connections, subagents), each with its own evaluation and reconciliation.

**The loop reads ambient state** instead of taking it as input. Identity and the sandbox come from the context container, and usage attributes go to Workflow (`recordModelUsage` calls `setEveAttributes`, which calls Workflow's `setAttributes`). The loop runs outside a Workflow step, but it logs a warning, and nothing states which context keys it needs.

**The session runtime is written against Workflow.** `runSessionLoop` waits for input on Workflow hooks, arms timers with `sleep`, and moves a session between runs with a handoff protocol. `turnStep` reads the callback URL and the step attempt from Workflow and writes lines to a World stream. The `Session` handle reaches sessions through a `Runtime` whose only implementation is `createWorkflowRuntime`. So every session, including one in a test, needs a Workflow world, and a host that wants eve in its own process has to drive the kernel itself: wrap tools for authorization, seed context keys, fold lines, and route answers. A local prototype did exactly that, and routing answers is the part it got wrong.

Hooks are not part of the problem. They are occurrence effects that run after a commit, and `ctx.continue()` on `turn.settled` (#5555) starts the next turn. That belongs to the session runtime and stays there. `next` decides how a turn ends; `ctx.continue()` decides whether another turn begins.

## Separating them

Each refactor below keeps observable behavior the same: the same prompts, the same facts, and the same checkpoints. The first six move a decision out of the loop or a dependency into the kernel's input; the draft stack implements them. The next four take Workflow out of the session step and the session loop, so a second host can run them.

### One writer for history

Every change to model history goes through one function. It checks the change and records what kind of change it is, so the commit can publish the right facts.

```ts
// Before: each stage assigns history.
step.session = { ...step.session, history: validate([...prompt, ...response]) };

// After: one writer.
step.session = changeHistory(step.session, { append: response });
step.session = changeHistory(step.session, { rewrite: compacted }); // checked, published as a rewrite
```

`changeHistory` accepts `append`, `extend`, `repaired`, and `rewrite`. In dev and check mode, it asserts that every tool result follows its call, exactly once.

### The next step as data

The kernel asks the harness what the turn does next and applies the answer. Rules that hold for every agent stay in the kernel, around the decision.

```ts
type Next =
  | { model: { note?: string } }
  | { calls: { tool: string; input?: JsonValue }[] }
  | { settle: { output: JsonValue | null } }
  | { fail: { message: string } };

async function afterModel(step: Step, lastStep: ModelStep) {
  if (blocked(step)) return park(step); // approvals and sign-ins
  if (hasQueuedTurnInput(step)) return continueTurn(step); // input that arrived mid-turn
  const next = await decide(step, "next", { lastStep });
  return apply(step, next); // settling waits for tasks; notes and calls are capped
}
```

### One evaluator for harness fields

A harness is a synchronous function that returns an object of lazy fields. The kernel evaluates only the field a decision needs, keeps a memo per decision, and turns a thrown error into a turn failure whose message reveals nothing internal.

```ts
type Lazy<T> = T | (() => T | Promise<T>);

type Harness = (ctx: HarnessContext) => {
  agent?: { model?: Lazy<Model>; instructions?: Lazy<Instructions>; tools?: Lazy<Tools> };
  history?: Lazy<HistoryMessage[]>;
  next?: Lazy<Next>;
};

const { value } = await evaluate(step, { decision: "next", field: (plan) => plan.next });
```

### What the model is given, as data

Today each piece of the system prompt is formatted as a string where it is produced. The base prompt is composed when the session refreshes: the authored instructions, a `Workspace` section, a note that tool calls run in parallel, and the skills list. Each model call then adds dynamic instructions and task guidance, and a recovery note when a retry drops a tool the provider rejected:

```ts
// Before: strings composed where each piece is produced.
session.agent.system = [
  instructionsBlock,
  workspaceSection,
  PARALLEL_ACTION_INSTRUCTION,
  skillsSection,
].join("\n\n");
system = [recoveryNote, session.agent.system, ...dynamicInstructions, ...taskGuidance];
```

After the refactor, what the model is given comes from two sources of data, and turning data into text is a separate function:

```ts
// After: data from two sources, rendered by the harness's agent.instructions.
const files = await declared(ctx); // what the agent's files say, resolved for this session
const eve = builtins(ctx); // eve's own tools, and its renderers from data to text
const instructions = eve.prompt.instructions(files); // the native harness's agent.instructions
system = [recoveryNote, ...instructions]; // the kernel's note, then the harness's text
```

- **`declared(ctx)`** is the agent's definition: `instructions` (`agent` and each file under `agent/instructions/`, with its role), `skills` (`name`, `description`, `deferred`, and `load()`), `tools`, `workspace`, and `model`. Default tools such as `bash` count as declared, because each fills an `agent/tools/<name>` slot that a file can replace or disable. Evaluating `declared(ctx)` is the evaluation that reactions do today, and it is lazy: a harness that replaces everything never pays for it.
- **`builtins(ctx)`** is what eve adds to support its own features. Its `tools` are `eve__skill`, `eve__task_wait`, `eve__task_cancel`, `eve__search` and `eve__tool`, and `eve__reply` when the turn has an output schema. Its `prompt` renderers are `skills(skills)`, `workspace(workspace)`, `tools(tools)`, `tasks()`, and `instructions(files)`, which composes eve's whole default system prompt from the others.

The kernel keeps only its recovery note. When a provider rejects a tool and the kernel retries the call without it, the note tells the model the tool is gone.

### History as one function

Before every model call, the kernel evaluates `history` and compares the result with the history it holds. The harness returns an array, and the kernel works out what changed:

```ts
const proposed = await evaluate(step, { decision: "history", field: (plan) => plan.history });

switch (compare(step.session.history, proposed)) {
  case "unchanged":
    break;
  case "tail": // only messages new since the last commit changed: part of the append
    step.session = changeHistory(step.session, { extend: proposed });
    break;
  case "rewrite": // older messages changed: checked, published as a rewrite
    step.session = changeHistory(step.session, { rewrite: check(proposed) });
    break;
}
```

The kernel knows the model's context window, which is a physical limit. It does not know a compaction threshold, which is policy. `ctx.size` reports the next call's estimated tokens and the model's window, and `session.compact()` arrives as `ctx.compact`. Today's compaction becomes `ctx.summarize(history)`, whose model call the kernel announces and bills. The threshold moves into the native harness, which compacts exactly when main does today.

The kernel doesn't react to a provider's context-overflow error. Providers don't share an error shape, and matching their wording is brittle; the AI SDK doesn't attempt it either. Compacting before the call is the policy's job.

There is no separate per-call prompt. The session's history is exactly what the model reads about the past. Anything specific to one call belongs to `agent`, and provider encoding such as attachment hydration and cache markers stays in the kernel. The full record of what happened is the stream, and `history` never changes it.

Compaction that runs in the background is the same function. `history` can start a summary job once the session nears its threshold, keep the job's handle in `ctx.memo`, and return the summary when the job is done, as long as the messages it summarized are still the start of the history. The kernel checks the result's structure; whether a summary still matches the history is the harness's check. A memo can run again after a crash, so starting the job twice must be harmless.

### The kernel's inputs

The kernel is a step function, `createKernel` (renamed from `createToolLoopHarness`). `execution/node-step.ts` builds it for a compiled agent node, with each tool wrapped for authorization:

```ts
const step = createKernel({ tools, resolveModel, policy, handleEvent, setAttributes, abortSignal });

let result = await step(session, { message });
while (typeof result.next === "function") result = await result.next(result.session);
```

Usage attributes reach Workflow through `setAttributes`, a sink the Workflow wrapper passes, and guard rule 58 keeps Workflow imports out of `harness/` (#5682). `handleEvent` is the publication sink, which runs the fold so the kernel's view stays current. Identity and the sandbox still come from the context container. Any host that sets up the same context, as the session step does, gets the same kernel; making them explicit matters only where `AsyncLocalStorage` doesn't exist, such as a browser.

### A session step without Workflow

`turnStep` runs a batch of model steps inside a Workflow step. Most of its body is not about Workflow: it admits the delivery, matches sign-in callbacks, recovers from an interrupted attempt, builds the kernel for the agent's node, and publishes lines, running hooks after each commit. What is about Workflow becomes the step's ports:

```ts
// The Workflow adapter supplies what only Workflow knows.
export async function turnStep(input: TurnStepInput) {
  "use step";
  return await runSessionStep(input, {
    lines: worldStream(input.sessionId), // write lines; read back what an interrupted attempt wrote
    retried: getStepMetadata().attempt > 1,
    callbackBaseUrl: getWorkflowMetadata().url,
    setAttributes,
  });
}
```

Guard rule 58 then covers `runSessionStep` and what it imports, as it covers `harness/` now.

### A session loop given a host

`runSessionLoop` waits for input on Workflow hooks, arms timers with `sleep`, checks that a timer or prewarm command is for the current run, moves the session between runs, and starts workflow tools, tasks, and child sessions as Workflow runs. Those become a host, and today's code becomes the Workflow host:

```ts
interface SessionHost {
  inbox: SessionInboxReader; // next input; claims the session's addresses
  timers: { until(deadline: Date): Promise<void> };
  owns(runId: string): boolean; // ignore a timer or prewarm armed by an earlier owner
  moves?: SessionMoves; // deployment and compaction handoff
  runs?: DurableRuns; // workflow tools, tasks, child sessions
}

await runSessionLoop(boot, host);
```

The loop itself does not change. Its rules, such as controls that arrive before the session starts, prewarming, and how cancel, clear, and compact settle, are subtle, and reusing them is what keeps an embedded session the same as a deployed one. A host without `runs` fails calls to workflow tools, tasks, and subagents with an error that names the missing capability, the way `SessionCapabilities.requestInput` already tells the gate whether a session can ask a person.

### Agents defined in code

The compiler already accepts programmatic sources, modules at logical paths, which framework defaults and the in-memory test compiler (`internal/testing/compile-from-memory.ts`) use. Moving that into the runtime gives an agent defined in code the same compiler, validation, and errors as one on disk, and names still come from paths:

```ts
// Proposed name.
const bundle = await compileProgrammaticAgent({
  "agent.ts": defineAgent({ model: "anthropic/claude-sonnet-5" }),
  "tools/bash.ts": bash,
  "tools/write_file.ts": defineTool({ ...writeFile, approval: always() }),
  "harness.ts": harness, // optional, like agent/harness.ts
});
```

The bundle installs into a runtime session scoped to its host (`withRuntimeSession`), so several agents can share a process.

### A second `Runtime`

With the step and the loop free of Workflow, an in-process `Runtime` is a host with an in-memory inbox, the process's clock, and a store for the session's lines and values. The store keeps the format handoff already uses, `SessionCheckpoint` and its migrations, so every host reads one format:

```ts
// Proposed name.
const runtime = createInProcessRuntime({ bundle, store }); // a Runtime, like createWorkflowRuntime
const session = createSession(sessionId, runtime); // the Session handle channels and routes use
```

It round-trips each step's input and output through Workflow's serializer, so a value that could not cross a Workflow step fails in process too. Its first users are integration tests that don't depend on Workflow's behavior. Running the same scenarios through both runtimes and comparing their events and prompts is what shows the two hosts agree: a batch with one approval and one denial, a follow-up turn, cancel, compact, clear, and a restart from the store.

### What collapses

| On main                                                                  | Becomes                                                              |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `continueLoop`, proposed `beforeSettle` callbacks, critic loops          | `next`                                                               |
| The compaction stage, `shouldCompact`, threshold options, new strategies | `history`, with a summarizer and the threshold in the native harness |
| Proposals to truncate or offload tool results                            | `history` edits to new messages, folded into the append              |
| Reactions for dynamic tools, instructions, and model                     | `declared(ctx)`, which `agent` reads                                 |
| Prompt sections formatted where they are produced                        | Renderers in `builtins(ctx)`, which `agent` calls or replaces        |
| Several writers of history                                               | `changeHistory`                                                      |
| Special handling for asking a person or waiting on tasks                 | Ordinary tool calls through the gate                                 |
| A new callback for each extension request                                | Nothing new                                                          |
| A Workflow world for every session, including in tests                   | The in-process `Runtime`                                             |
| Glue that each embedding writes around the kernel                        | The session loop, given a host                                       |

## The harness loop

The kernel evaluates the harness at fixed decision points:

| Where                                | What the kernel evaluates                                       |
| ------------------------------------ | --------------------------------------------------------------- |
| Turn start, before any model call    | `next`, which may settle, fail, or call tools without the model |
| Before each model call               | `history`, then `agent`                                         |
| After each model step                | `next`                                                          |
| After the harness's own calls settle | `next`                                                          |

The harness reads the session as of its latest commit:

| Field                                      | Meaning                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `ctx.history`                              | The model history as of this decision                                                                  |
| `ctx.input`                                | Proposed: the message that opened the turn                                                             |
| `ctx.calls`                                | The turn's calls: tool, input, status, outcome, and output when small enough                           |
| `ctx.lastStep`                             | The model step that just ended: `text`, `output`, and `endsTurn`                                       |
| `ctx.unread`                               | Proposed: history ends with tool results the model has not read                                        |
| `ctx.steps`, `ctx.continuations`           | Model calls this turn, and notes the harness added                                                     |
| `ctx.size`, `ctx.compact`, `ctx.summarize` | The next call's tokens and the model's window; a `session.compact()` request; eve's summarizer         |
| `ctx.memo`                                 | A cache across evaluations. A crash or a deployment can run it again, so it is not a record of effects |
| `ctx.session`, `ctx.signal`                | Identity and session metadata, as dynamic values read them; the turn's abort signal                    |

Whatever the harness returns, the kernel enforces:

- Every call, the model's or the harness's, passes the gate. A harness cannot skip or answer an approval or a sign-in.
- A turn does not settle while its tasks work. The kernel waits and calls the model with their results.
- Input that arrives during a turn is read in that turn.
- Notes and harness calls per turn are capped.
- Usage limits are checked before model calls and harness calls, and every model call, including the harness's own, is billed.
- History changes are checked: results follow calls, the turn's input stays, and the prompt fits.
- A settled output is validated against the turn's output schema, as a model's would be.
- A harness that throws fails the turn with a generic message.

### The system prompt

The system prompt is the kernel's recovery note, when there is one, then exactly what `agent.instructions` returns, in that order. eve's default is `builtins(ctx).prompt.instructions(files)`: the agent's instructions, the workspace, the tools note, the skills list, the files under `agent/instructions/`, and task guidance when tasks are offered. A string replaces all of it. An array can keep, reorder, or drop each piece, and can render a piece in its own way; empty entries are skipped.

Skills show why rendering belongs to the author. eve's skills list mixes data (each skill's name and description), mechanism (load a skill with `eve__skill({ name })`), and policy ("activate the minimal set"). With skills as data, all three are the author's:

```ts title="agent/harness.ts"
import { declared, defineHarness } from "eve/experimental/harness";

export default defineHarness((ctx) => ({
  agent: {
    instructions: async () => {
      const files = await declared(ctx);
      const refunds = files.skills.find((skill) => skill.name === "refunds");
      const others = files.skills.filter((skill) => skill !== refunds && !skill.deferred);

      return [
        "You are Acme's billing assistant.",
        files.instructions.agent.content,
        await refunds?.load(), // always in context, not loaded on demand
        "Load these with eve__skill({ name }) when a request needs one:\n" +
          others.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
      ];
    },
  },
}));
```

`eve__skill` loads by name however the list is rendered, so a custom rendering only has to tell the model the tool exists. When skills change mid-session, the native harness announces them as history messages so the start of the prompt stays cached; a custom harness can render the list again instead, at the cost of that cache. The kernel keeps placing the provider's cache breakpoint at the end of the system prompt, so system text that changes from call to call costs the prompt cache wherever it sits.

Tools follow the same rule. A harness that sets `agent.tools` offers exactly what it returns, and leaving out one of eve's tools turns off what it serves. Without `eve__skill`, skills cannot load. Without `eve__task_wait`, the model cannot wait on tasks, though the turn still does not settle while they work. Without `eve__reply`, the model cannot deliver structured output, so the harness settles the turn itself.

### eve's loop as a harness

This is the whole native policy:

```ts
export const native: Harness = (ctx) => ({
  history: () =>
    ctx.compact || ctx.size.tokens > compaction.threshold * ctx.size.window
      ? ctx.summarize(ctx.history)
      : ctx.history,

  next: () => {
    const last = ctx.lastStep;
    if (last === undefined) return { model: {} }; // turn start
    if (last.output !== undefined) return { settle: { output: last.output } };
    if (ctx.unread && !last.endsTurn) return { model: {} }; // results the model hasn't read
    return { settle: { output: last.endsTurn ? null : last.text } };
  },

  agent: {
    model: async () => (await declared(ctx)).model,
    instructions: async () => builtins(ctx).prompt.instructions(await declared(ctx)),
    tools: async () => ({ ...(await declared(ctx)).tools, ...builtins(ctx).tools }),
  },
});
```

`compaction.threshold` (0.9 by default) and `compaction.model` are today's options from `agent.ts`. The rest of today's `continueLoop` (parking, queued input, and tasks) is a kernel rule, so it does not appear here.

## What you can build with it

Each example is a complete `agent/harness.ts`, written against the API sketched in [Later: exposing it](#later-exposing-it). A field the harness leaves out, or returns `undefined` from, is eve's own. Small helpers such as `textOf` and `preview` are left out.

<details>
<summary><strong>Critic:</strong> check the draft before the turn settles, and send it back with a note.</summary>

```ts title="agent/harness.ts"
import { defineHarness } from "eve/experimental/harness";
import { decide } from "eve/ai";

export default defineHarness((ctx) => ({
  next: async () => {
    const draft = ctx.lastStep?.text;
    if (!draft || ctx.unread || ctx.continuations >= 2) return undefined;

    const { answers } = await decide({
      state: { request: ctx.input, draft },
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

The turn still produces one reply. The rejected draft stays in history before the note, so the model revises with both in view. The `decide` call is billed to the turn, and the kernel caps notes per turn whatever the harness returns.

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

The call still passes the gate. If `deploy` requires approval, the turn waits for an answer, and a denial settles the call as `rejected`. Every other message falls through to eve's loop.

</details>

<details>
<summary><strong>Model cascade:</strong> answer on a fast model, and escalate when the draft falls short.</summary>

```ts title="agent/harness.ts"
import { defineHarness } from "eve/experimental/harness";
import { decide } from "eve/ai";

export default defineHarness((ctx) => {
  const escalated = ctx.continuations > 0;

  return {
    agent: { model: escalated ? "openai/gpt-6-sol" : "openai/gpt-6-luna" },

    next: async () => {
      const draft = ctx.lastStep?.text;
      if (escalated || !draft || ctx.unread) return undefined;

      const { answers } = await decide({
        state: { request: ctx.input, draft },
        questions: {
          complete: {
            type: "boolean",
            instructions: "Does the draft fully and correctly answer the request?",
          },
        },
        signal: ctx.signal,
      });

      return answers.complete.probability >= 0.7
        ? undefined
        : { model: { note: "Review the draft above and give a complete, careful answer." } };
    },
  };
});
```

Whether the turn has escalated comes from the turn itself, a note the harness added, so it holds across crashes and redeploys without stored state.

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

`preview` returns at most `LIMIT` characters, so results trimmed earlier come back unchanged. Only the newest result changes, and the kernel folds that change into the append: no rewrite fact and no prompt-cache miss. Clients still show the full output from `call.settled`. If the model may need the full output later, offload it and put a reference in the preview that a tool can read.

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

When to compact is a line of code, not a setting. The summarizer's model call is announced as a compaction run and billed to the session. If the result still does not fit the window, the turn fails; eve does not fall back to its own compaction.

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

    agent: {
      tools: async () => {
        const { tools } = await declared(ctx);
        const { deploy, bash, ...rest } = tools;
        const plan = (await workspace()).plan;
        return { ...(plan === "enterprise" ? tools : rest), ...builtins(ctx).tools };
      },
      instructions: async () => [
        ...builtins(ctx).prompt.instructions(await declared(ctx)),
        `This workspace is on the ${(await workspace()).plan} plan.`,
      ],
    },
  };
});
```

One cached lookup drives three decisions. A suspended workspace fails before the model runs, and workspaces off the enterprise plan never see `deploy` or `bash`. The harness adds eve's own tools back, because a harness that sets `tools` offers exactly what it returns.

</details>

## Embedded eve: a terminal agent in one file

With an in-process `Runtime`, an agent defined in code runs with no compiler output and no Workflow world. This is a complete local terminal agent with eve's own `bash`, `read_file`, and `write_file` tools in an in-process just-bash sandbox, and approvals answered inline:

```ts title="agent.ts"
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
  sandbox: JustBashSandbox.environment(),
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

`createSession` compiles the definition as a programmatic agent and returns the `Session` handle over an in-process `Runtime`, with the host's user as its default identity. It has the same shape as `Session` from `eve/sessions` and `ClientSession` from `eve/client`: `send` returns a `Delivery` with `stream()` and `result()`, and `respond`, `cancel`, and `compact` work as they do there. A UI written against one can switch to the other. The tools, the gate, the facts, the fold, and the session loop are the ones a deployed agent uses, and `result().interactions` comes from the same selectors. A prototype that drives the kernel directly runs today: `bash` runs at once, `write_file` waits for the approval, and a later turn keeps the context. Its own glue for tool authorization, context, folding, and answers is what the in-process `Runtime` replaces.

An embedded session gets what its host provides. The in-process host provides input, answers, cancel, compact, clear, the sandbox, connections, hooks, and `defineState`. Workflow tools, tasks, and subagents need durable runs, which it does not provide, so calls to them fail with an error that says so. An OAuth sign-in needs a callback the host can receive.

Separating the layers makes these possible:

- Tests and eval drivers that run whole sessions in process, with no server and no Workflow world.
- Local CLIs and desktop agents that store the session wherever the host likes.
- Other hosts. Channels and schedules already speak `Runtime`, so a host with its own store, queue, and timer could serve them too.

## Later: a store instead of replay

Today a session is one Workflow run, and its memory is the run's event log. Each time the session wakes, Workflow runs the session loop again from the top and returns recorded results for the steps, hooks, and sleeps it already passed. Much of the session runtime exists because of that:

- Only the code that started a run can replay it, so new code reaches a session only when the session is handed to a new run, and only while it is idle.
- The event log grows with every step, and each turn step's input carries the whole history, so after compaction eve moves the session to a fresh run. A session that never compacts approaches Workflow's event limit.
- On self-hosted worlds, an upgrade strands every session, and its next message starts a replacement session (`SessionStrandedError`, `ctx.session.predecessor`).

With the loop on a host, a host can instead keep each session as a checkpoint plus a record of each step since, which today's step results already are (`SessionStateDelta`). A wake loads them, runs the next step on whatever code received the wake, and appends what changed. pi-durable and fx's libfx both persist sessions this way.

```text
today   session = a Workflow run          deploy: idle handoff · compaction: new run · self-hosted upgrade: stranded
store   session = checkpoint + records    deploy: the next wake runs new code · no handoff · no stranding
```

Two things do not change. Authored workflow tools are still Workflow runs and stay on the code that started them, so after a self-hosted upgrade such a call fails instead of the session. And compatibility moves from code to data: the next version must read parked approvals, sign-ins, and tasks, through the checkpoint versions and migrations handoff uses, and an older version must refuse records newer than it understands.

It would also remove costs that replay adds. In three runs of the `agent-workflow-stress` e2e fixture on Vercel Workflow with a mock model, a model-call boundary inside a turn took about 330 ms, and waking a session for its next message took about half a second at first and grew about 3 ms per turn, to 0.76–0.93 s by turn 100. A store would remove the replay that grows and the history written with every step. How much of the step boundary it would remove needs a breakdown of those 330 ms first.

It can arrive in stages that each stand alone: first, session steps read their values from the store by cursor under today's loop; then any run can pick up a session from the store; then runs end when the session parks.

## Later: exposing it

The draft stack already exports the first piece, `defineHarness` with `declared(ctx)` and `builtins(ctx)`, from `eve/experimental/harness`. The full set could become public in steps after 1.0, each experimental first:

- **`agent/harness.ts`** default-exports `defineHarness((ctx) => plan)`. Authors adopt one field at a time: `next` for a critic or a command, `history` for compaction or trimming, `agent` for per-call tools and models, or all three.
- **Composition is a function call.** A harness that wants eve's compaction plus its own trimming calls eve's exported native pieces inside its own `history`. There is no ordered pipeline of processors.
- **`declared(ctx)` and `builtins(ctx)`** from `eve/experimental/harness` give a harness what the files declare and what eve adds, as data, along with eve's renderers. A harness that sets `agent.instructions` or `agent.tools` gets exactly what it returns.
- **`compaction` options in `agent.ts`** keep configuring the native harness. A harness that defines `history` owns compaction.
- **`eve/experimental/embed`** exports `createSession`, which takes an agent definition in code, with a store, identity, and a sandbox optional, and returns the `Session` handle. The protocol's selectors are already public for hosts that render their own UI.
- **A host interface** for other stores, queues, and timers could follow once the Workflow host and the in-process host have proven it. A deployed runtime on a store would plug in there.
- **What stays sealed** is the kernel's list above: the gate, tasks, input, caps, usage, history checks, output validation, and failures that reveal nothing internal.

Before any of it becomes stable, it needs an updated research doc, docs pages, e2e evals for each verb and its failure modes, and a changeset.
