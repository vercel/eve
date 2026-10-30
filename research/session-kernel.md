---
issue: "None (maintainer-requested research)"
status: proposed
last_updated: "2026-10-30"
---

# eve in layers: a sealed kernel, harnesses, and hosts

## Summary

eve is built for sessions that run for a long time and involve more than one person. Several people share a conversation, approvals and sign-ins wait for days, and channels and clients all read the same record. That record is the session's event stream, and its facts carry guarantees. The clearest one: when the model asks for a call that needs approval, the request appears in the stream, and the call cannot run until someone allowed to answer approves it.

This plan splits eve into layers so those guarantees hold whatever runs on top of them and wherever they run:

- A sealed **kernel** becomes the only code that writes facts and the only path by which a call runs.
- A **harness** is a function the kernel evaluates: the model, instructions, tools, and history the next model call gets, and what the turn does next. eve's own loop is one harness, written in the shape any author would use.
- A **host** decides where a session runs: on Workflow when deployed, or inside one process for an agent embedded in a CLI, a worker, or a test.

The plan covers internal refactors that leave the stream unchanged, and an experimental API that could follow after 1.0. Nothing here is part of 1.0. A draft of the kernel and harness split is GitHub stack #5638, #5566, #5604, #5609, #5621, and #5640, and this document uses its names. What the stack doesn't have yet is marked as proposed, including the harness's flat shape: the stack groups the model, instructions, and tools under `agent`. Code in this document is pseudocode, and signatures are simplified.

## What eve guarantees

A multi-party session needs more than a model loop. It needs to know who said what, who may approve what, which requests are waiting on which person, and what happened to every call the model asked for. eve records all of it as facts that clients, channels, hooks, and the kernel fold into one view.

An approval shows how much rests on those facts:

```text
model asks for a call ──► call.requested
                               │
                     gate: the tool's approval policy
             ┌─────────────────┼──────────────────────┐
          allowed       needs a person              denied
             │                 │                       │
             │        interaction.opened               │
             │        turn.paused                      │
             │                 │                       │
             │        an answer arrives                │
             │        interaction.settled              │
             │          ┌──────┴───────┐               │
             │      accepted        declined           │
             │          │              │               │
             │   policy and input      │               │
             │   checked again         │               │
             ▼          ▼              ▼               ▼
     call.started (clearedBy)     call.settled: rejected
             │
       call.settled
```

A client that shows "waiting for approval" trusts that `call.started` never comes first. A channel that posts an approval card trusts that one answer settles the whole batch the model asked for together. Whoever approves, the call still runs as the person whose turn made it, so an approval doesn't lend the approver's credentials.

Much of this is enforced today. The gate decides every call the model makes. The stream checker (`protocol/session-events/checker.ts`) checks lifecycle rules on every line in unit and integration tests and under `eve dev`. Guard rule 51 limits which modules build lifecycle events, and rule 53 keeps the protocol standalone.

No single component owns the guarantee, though. Rule 51 documents its own gaps: approval candidates are written to state directly, and call results are built in `call-executor.ts` rather than in the session machine. Outside `harness/`, a few facts are built by hand, and one path writes to the stream without the checker. The checker has no rule that ties a call's start to its approval. Nothing in eve is known to break the contract, but the contract holds because separate pieces of code agree, not because one owner enforces it.

The contract covers effects that go through eve. Arbitrary code in a tool or a host can still reach an external service directly, so the contract is not a defense against a malicious host. Provider-executed tools, such as a provider's web search, run inside the model call, where eve cannot gate them, so offering one is the decision to allow it. Sandboxes and scoped credentials limit what an approved call can reach, and they complement the gate rather than replace it.

## The layers

These are the layers this plan proposes. The kernel section describes where today's code differs.

```text
authoring        agent/ files and the compiler · an agent defined in code
session runtime  admission · inbox · answers · controls · tasks · hooks
harness          model · instructions · tools · history · next         replaceable
kernel           machine · commit · step                               sealed
protocol         facts · progress · fold · selectors
host             input · timers · storage · durable runs               Workflow, or one process
```

- **Protocol** is the session's record: facts, which are authoritative; progress, which previews work in flight; the fold that turns both into a view; and the selectors that read the view.
- **Kernel** owns the guarantees. Its machine turns the session's view and an input into facts, its commit orders and checks them, and its step calls the model and runs calls through the gate.
- **Harness** is policy. It returns data that the kernel applies.
- **Session runtime** is everything between steps: admitting deliveries, queueing input, routing answers, applying controls such as cancel and compact, running tasks, and running hooks after each commit. It submits inputs to the kernel and never writes facts itself.
- **Host** is what the session runtime waits on and writes to: an inbox, timers, storage for the stream and the session's values, and, where it can, durable runs for workflow tools, tasks, and child sessions.
- **Authoring** produces the resolved agent the other layers run. `agent/` files through the compiler is one way; an agent defined in code is another.

Hooks and `ctx.continue()` belong to the session runtime. A hook is an effect that runs after a commit, and `ctx.continue()` on `turn.settled` (#5555) queues the next turn. `next` decides how a turn ends; `ctx.continue()` decides whether another one begins.

## The kernel

### A step

A step starts when the harness chooses the model and ends when the harness is asked what happens next:

```text
harness: next = model
     │
     ▼
kernel evaluates model · instructions · tools · history
     │   a history change is checked and recorded
     ▼
provider call through the AI SDK ──► normalized response
                                            │
                                ┌───────────┴───────────┐
                              text                 tool calls
                                │                       │
                        content facts           each through the gate
                                                  allowed ──► runs
                                                  a person ──► interaction, park
                                                  denied ──► rejected result
     ┌──────────────────────────────────────────────────┘
     ▼
results join history ──► harness: next
```

Two translations happen. The provider adapter turns the provider's response into text, tool calls, and usage; that is mechanics, and the AI SDK does it. The kernel turns each tool call into a governed call: it resolves the tool, validates the input, applies approval and authorization, and runs the call or parks it. Choosing `model` includes dispatching the tool calls the response makes through the gate, so a harness doesn't repeat that bookkeeping. A harness that wants to inspect calls before they run would need a separate, explicit capability.

### Dispatch

The kernel decides whether a call runs. An execution adapter decides how:

```text
call requested, by the model or the harness
        │
kernel: validate · gate · authorize · call.started
        │
execution adapter
  ├─ function            runs in the step
  ├─ sandbox operation   runs in the session's sandbox
  └─ durable run         the host starts a workflow tool, task, or child session
        │
kernel: call.settled · the result joins history
```

A durable run reports back to the session as input, and the kernel settles the call. No adapter is a second route around the gate.

### Sandboxes and connections

A sandbox is where an operation runs and what it can reach. A connection is an authenticated client for an external service. Both are execution environments: the host provides or provisions them, tools use them, and the kernel governs each call into them. An approval covers the operation the tool declares, not every effect the operation can reach, so approving `bash` grants whatever the sandbox allows.

### What no harness can change

Whatever a harness returns, the kernel enforces these rules:

- Every call, the model's or the harness's, passes the gate. A harness cannot skip, answer, or forge an approval or a sign-in.
- A call runs as the person whose turn made it.
- A turn doesn't settle while its tasks work. The kernel waits for them and calls the model with their results.
- Input that arrives during a turn is read in that turn.
- After a model step, `model` needs something the model hasn't read: tool results or a note. A note must say something, and a turn gets at most three. Past that, eve's own decision applies.
- Usage limits apply before every model call and before a harness's calls, and every model call is billed, including the summarizer's and `decide()`'s (#5638).
- History changes are checked: every tool result follows its call once, no call loses its result, a summary opens the history, the running turn's input stays, and the history fits the model's window.
- A settled output is validated against the turn's output schema, as a model's would be.
- A harness that throws or returns something invalid fails the turn with "The agent's harness failed." The reason goes to the logs only.

### One author for facts

Today the session machine (`harness/session-machine/`) builds most facts, but not all of them, and not all facts reach the stream through the same path:

```text
today

turn steps ─────────────► step loop → session machine · hitl ·   ──┐
                                      call-facts · facts.ts        │
other session steps ────► machine transitions · facts.ts ──────────┤
  controls · duplicates · cancel · tasks ·                         ▼
  session end · relays · run messages             publish-session-events.ts (execution/)
                                                  closes what owners leave open · positions ·
built by hand in execution/ ───────────────────►  dev checker · hooks · World writer
  delivery admit and ignore · session.started ·                    │
  child.opened and child.sent                                      ▼
                                                             session stream
end-stranded-session.ts ──► World writer directly, unchecked ──────┘
```

Proposed, the machine is the only author, and the publisher splits by owner:

```text
proposed
                     kernel
               ┌────────────────────────────────────────────┐
turn step ───► │ step (model and tools) ──┐                 │
               │                          ▼                 │
inputs ──────► │ machine: view + input → facts + state      │  the only author of facts
  delivery     │                          ▼                 │
  control      │ commit: order · close · check → lines      │
  run message  └──────────────────────────┬─────────────────┘
  relay                                   │ lines
  session end                             ▼
                               host writes bytes ──► session stream, unchanged
                                          │
                               runtime runs hooks ──► new inputs
```

The hand-built facts become machine transitions, the stranded-session end goes through the commit like any other fact, and rule 51's guard extends from `harness/` to the whole package. The one exemption is `execution/v26-history.ts`, which translates streams recorded before v27 as they are read and never writes.

Relays already work this way. A child session or a workflow run sends its parent a relay message whose events look like facts. The parent's `relay()` transition treats them as input: it skips events that aren't about a call the parent is running, ignores repeats, sets the subject and origin itself, and builds its own facts. The relay message and the stream both stay as they are. A relayed interaction carries an `origin`, so an approval relayed from a child never clears one of the parent's own calls.

The machine and the commit need only the session's view, not a loaded agent. That matters because some facts are written exactly when an agent can't be built: a session's end, a terminal failure, or a session stranded by an upgrade. `createKernel`, which builds a step for one agent's model, tools, and harness, sits on top of the machine; it isn't where the authority lives.

### How the kernel is checked

The stream checker already enforces introduction before reference, one terminal fact per entity, closed outcome sets, closure when an owner ends, one open turn, attempts, progress, pauses that wait on a person, calls served by running tasks, and approval batches that settle together. It runs in the writer during unit and integration tests and under `eve dev`, so a producer's mistake fails where it happens.

The proposed addition is authorization. A `call.started` for a call that has its own approval request must follow that request's `interaction.settled` with `accepted`, and its `clearedBy` must name that request. A negative control proves the rule: a test that deliberately skips the gate must fail the checker. Because a harness's calls emit the same facts as the model's, the rule covers them with no extra work.

Two more properties keep the kernel testable apart from any host. Guard rule 58 keeps Workflow out of `harness/`, so the step can run with a fake model and no Workflow world. The machine's transitions are pure, so they are tested directly.

## Harnesses

### The shape

```ts title="agent/harness.ts"
import { builtins, declared, defineHarness } from "eve/experimental/harness";

export default defineHarness((ctx) => ({
  model: ..., // which model, with its options
  instructions: ..., // the whole system prompt
  tools: ..., // every tool the model is offered
  history: ..., // what the model remembers, which becomes the session's history
  next: ..., // what the turn does next
}));
```

The function itself is cheap and synchronous: it says what each field is. Every field can be a value or a function, and the kernel calls a function only where it needs that value. A field the harness leaves out, or returns `undefined` for, is eve's own.

The flat shape is proposed. Everything except `next` describes the next model call, and the kernel evaluates those fields only when `next` chooses the model, or, for `history`, when `session.compact()` asks. `history` differs from the other three in one way: what it returns persists as the session's history, while the model, instructions, and tools apply to one call.

The kernel evaluates the harness at these points:

| Where                                | What the kernel evaluates                                       |
| ------------------------------------ | --------------------------------------------------------------- |
| Turn start, before any model call    | `next`, which can settle, fail, or call tools without the model |
| Before each model call               | `model`, `instructions`, `tools`, and `history`                 |
| After each model step                | `next`                                                          |
| After the harness's own calls settle | `next`                                                          |
| `session.compact()`                  | `history`                                                       |

### `next`

`next` returns one of four values:

```ts
type Next =
  | { model: { note?: string } } // call the model, after showing it the note
  | { calls: { tool: string; input?: JsonValue }[] } // call tools, then decide again
  | { settle: { output: JsonValue | null } } // end the turn with this reply
  | { fail: { message: string } }; // end the turn as failed
```

A harness's `calls` go through the same gate as the model's: approval, sign-in, and workflow and task tools park the same way, and history records the batch as calls the agent made. Today a harness can call the tools the step offers the model. Letting it call any of the agent's tools, offered or not, is proposed.

When a harness decides the reply, the model's text streams as a draft until the harness settles the turn, and channels such as Slack post only the reply. A critic can then reject a draft before a channel posts it.

### `model`, `instructions`, and `tools`

`model` accepts what `agent.ts`'s `model` accepts: an AI Gateway model id, a model instance, or a selection such as `{ model, modelOptions, reasoning }`, the value `defineDynamic()` returns. Provider options travel with the selection.

`instructions` is the whole system prompt. A string is all of it; an array's entries join, and empty ones are skipped. The kernel puts only its own recovery note first, when a provider rejected a tool and the kernel retried without it. The kernel places the prompt cache breakpoint at the end of the system prompt, so system text that changes from call to call costs the cache wherever it sits.

`tools` is every tool the model is offered, exactly as returned. Leaving out one of eve's tools turns off what it serves. Without `eve__skill`, skills can't load. Without `eve__task_wait`, the model can't wait on tasks, though the turn still waits for them. Without `eve__reply`, the model can't deliver a structured result, so the harness settles the turn itself.

Two functions give a harness the parts to compose these from:

- **`declared(ctx)`** is what the agent's files declare, as data: `instructions` (the agent's own and each file under `agent/instructions/`, with its role), `skills` (`name`, `description`, `deferred`, and `load()`), `tools`, `workspace`, and `model`. Default tools such as `bash` count as declared, because each fills an `agent/tools/<name>` slot that a file can replace or turn off. It is evaluated only when a harness asks.
- **`builtins(ctx)`** is what eve adds for its own features: the `eve__` tools, and renderers that turn declared data into eve's prompt sections (`skills`, `workspace`, `tools`, `tasks`, and `instructions`, which composes eve's whole default prompt).

Skills show why rendering belongs to the author. eve's skills list mixes data (each skill's name and description), mechanism (load one with `eve__skill({ name })`), and policy ("activate the minimal set"). With skills as data, all three are the author's:

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
      await refunds?.load(), // always in context, not loaded on demand
      "Load these with eve__skill({ name }) when a request needs one:\n" +
        others.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n"),
    ];
  },
}));
```

### `history`

The stream records what happened, and history is what the model remembers. `history` is one function the kernel evaluates before every model call and for `session.compact()`. It returns an array, and the kernel works out what changed:

- If nothing changed, nothing is recorded.
- If only messages the model hasn't read yet changed, the change joins the append.
- If messages the model has read changed, the kernel checks the new history and records the change as a rewrite.

Compaction is one history policy, not a stage of its own. The kernel knows the model's context window, which is a physical limit, and reports the next call's size as `ctx.size`. It doesn't know a compaction threshold, which is policy and lives in eve's harness. `ctx.summarize(history)` is eve's summarizer, and the kernel announces and bills its model call. The kernel doesn't react to a provider's context-overflow error, because providers don't share an error shape; compacting before the call is the harness's job.

Other history policies use the same function: dropping large tool results, keeping only relevant turns, or keeping some messages verbatim. The kernel checks a new history's structure, not whether a summary is faithful to what it replaced.

### What a harness reads

| Field                                      | Meaning                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `ctx.history`                              | The model history as of this decision                                                           |
| `ctx.calls`                                | The turn's calls: tool, input, status, outcome, and output when small enough                    |
| `ctx.lastStep`                             | The latest model step: `text`, `output`, and `endsTurn`                                         |
| `ctx.steps`, `ctx.continuations`           | Model calls this turn, and the notes the harness added                                          |
| `ctx.size`, `ctx.compact`, `ctx.summarize` | The next call's tokens and the model's window; a `session.compact()` request; eve's summarizer  |
| `ctx.memo`                                 | A cache across evaluations. A crash or a deployment can run it again, so it isn't an effect log |
| `ctx.session`                              | The session's id, identity, and metadata, as dynamic values read them                           |
| `ctx.input`                                | Proposed: the message that opened the turn                                                      |
| `ctx.unread`                               | Proposed: history ends with tool results the model hasn't read                                  |
| `ctx.signal`                               | Proposed: the turn's abort signal                                                               |

### eve's harness

This is eve's whole default harness:

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

Everything else today's loop decides, such as parking for approvals, reading queued input, and waiting for tasks, is a kernel rule, so it doesn't appear here.

### What you can build

Each example is a complete `agent/harness.ts`, and some use the proposed `ctx` fields from the table above. Fields an example leaves out are eve's own. Small helpers such as `textOf`, `size`, and `preview` aren't shown.

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

This manages history without compacting it. `preview` returns at most `LIMIT` characters, so results trimmed earlier come back unchanged. Only the newest result changes, and the kernel folds that change into the append, so there is no rewrite and no prompt-cache miss. Clients still show the full output from `call.settled`.

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

When to compact is a line of code, not a setting. The summarizer's model call is announced as a compaction and billed to the session. If the result still doesn't fit the window, the turn fails; eve doesn't fall back to its own compaction.

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

The turn has one reply. The rejected draft stays in history before the note, so the model revises with both in view, and channels never post it. The `decide()` call is billed to the turn.

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

The call still passes the gate. If `deploy` needs approval, the turn waits for an answer, and a denial settles the call as `rejected`. Every other message falls through to eve's loop.

</details>

<details>
<summary><strong>Model cascade:</strong> answer on a fast model, and escalate when the draft falls short.</summary>

```ts title="agent/harness.ts"
import { decide } from "eve/ai";
import { defineHarness } from "eve/experimental/harness";

export default defineHarness((ctx) => {
  const escalated = ctx.continuations > 0;

  return {
    model: escalated ? "openai/gpt-6-sol" : "openai/gpt-6-luna",

    next: async () => {
      const draft = ctx.lastStep?.text;
      if (escalated || !draft || ctx.unread) return undefined;

      const { answers } = await decide({
        state: { request: textOf(ctx.input), draft },
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

Whether the turn has escalated comes from the turn itself, a note the harness added, so it holds across crashes and deployments without stored state.

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

One cached lookup drives three decisions. A suspended workspace fails before the model runs, and workspaces off the enterprise plan never see `deploy` or `bash`. The harness adds eve's tools back, because a harness that sets `tools` offers exactly what it returns.

</details>

## Hosts and embedded eve

### What a session needs to run

The compiler and the `agent/` layout produce a resolved agent, and deployment features such as channels, schedules, and routes need them. The kernel and the session's semantics don't. The compiler already accepts programmatic sources, modules at logical paths, which framework defaults and the in-memory test compiler use. Running an agent defined in code through that same path gives it the compiler's validation and errors, and names still come from paths.

The kernel alone is not enough to run a session, though. Routing an answer to the call it decides, admitting a message that arrives during a turn, binding identity, applying cancel and compact, and recovering an interrupted step all live in the session runtime. A local prototype that drove the kernel directly had to rebuild that glue, and routing answers is the part it got wrong. An embedded session has to reuse the session runtime, not only the kernel.

```text
agent/ files ──► compiler ──┐
agent defined in code ──────┴──► resolved agent
                                       │
                          Session handle (eve/sessions)
                                       │
                                    Runtime
                           ┌───────────┴────────────┐
                createWorkflowRuntime      in-process Runtime (proposed)
                           └───────────┬────────────┘
                       one session loop, given a host
                                       │
                                harness · kernel
                                       │
                              protocol · fold · selectors
```

`Session` from `eve/sessions` already reaches sessions through a `Runtime` interface, and `createWorkflowRuntime` is its only implementation. An in-process `Runtime` would be a second implementation behind the same handle, so a UI written against one runs against the other.

### What a host provides

Today the session loop (`runSessionLoop`) and the session step (`turnStep`) are written against Workflow. They wait on Workflow hooks, arm Workflow sleeps, and read Workflow's step metadata. Proposed, the loop takes its mechanisms from a host, and the Workflow-specific reads move into a thin Workflow adapter around a shared step:

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

The loop itself doesn't change. Its rules, such as controls that arrive before a session starts, prewarming, and how cancel, clear, and compact settle, are what keep an embedded session the same as a deployed one. The publisher's split above gives the shared step its other port: the host writes the lines the kernel commits, and reads back what an interrupted attempt wrote.

|                                      | Workflow host                     | In-process host                                     |
| ------------------------------------ | --------------------------------- | --------------------------------------------------- |
| Input                                | Workflow hooks                    | An in-memory queue                                  |
| Timers                               | Durable `sleep`                   | The process's timers                                |
| Storage                              | The run's stream and step results | A store the embedder passes, or memory              |
| Workflow tools, tasks, and subagents | Workflow runs                     | Not provided; calls fail with an error that says so |
| Moving between deployments           | Handoff                           | Not needed                                          |
| A session that outlives the process  | Yes                               | Only with a store                                   |

The in-process store would keep the format handoff already uses, `SessionCheckpoint` and its migrations, so a session saved by one host reads in any host. Each step's input and output would round-trip through Workflow's serializer, so a value that couldn't cross a Workflow step fails in process too. The first users would be integration tests that don't depend on Workflow's behavior. Running the same scenarios through both hosts and comparing their streams and prompts would show the hosts agree: a batch with one approval and one denial, a follow-up turn, cancel, compact, clear, and a restart from the store.

A host could also keep a deployed session as a checkpoint plus records instead of replaying a Workflow run, which would end version pinning. That is a separate proposal.

### A terminal agent in one file

This sketch of a proposed `createSession` is a complete local terminal agent with eve's `bash`, `read_file`, and `write_file` tools in an in-process just-bash sandbox, and approvals answered inline:

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

`createSession` compiles the definition as a programmatic agent and returns the `Session` handle over an in-process `Runtime`, with the host's user as its default identity. `send` returns a `Delivery` with `stream()` and `result()`, and `respond`, `cancel`, and `compact` work as they do on a deployed session. The tools, the gate, the facts, the fold, and the session loop are the ones a deployed agent uses, so `bash` runs at once, `write_file` waits for its approval, and `result().interactions` comes from the same selectors a deployed client reads.

The same handle could sit behind a web chat in a small worker. The worker still needs the routes a client calls and server-side authentication for its users, and a sign-in needs a callback URL the worker can receive. Approvals can wait as long as the process lives, or across restarts with a store.

## Later: exposing it

The draft stack exports the first piece, `defineHarness` with `declared(ctx)` and `builtins(ctx)`, from `eve/experimental/harness`. The rest could become public in steps after 1.0, each experimental first:

- **`agent/harness.ts`** default-exports `defineHarness((ctx) => ({ model, instructions, tools, history, next }))`. Authors adopt one field at a time: `next` for a critic or a command, `history` for compaction or trimming, `model`, `instructions`, or `tools` per call, or all of them.
- **Composition is a function call.** A harness that wants eve's compaction plus its own trimming calls eve's exported native pieces inside its own `history`. There is no ordered pipeline of processors.
- **`compaction` options in `agent.ts`** keep configuring eve's harness. A harness that defines `history` owns compaction.
- **`eve/experimental/embed`** exports `createSession`, which takes an agent defined in code, with a store, an identity, and a sandbox optional, and returns the `Session` handle.
- **A host interface** for other stores, queues, and timers could follow once the Workflow host and the in-process host have proven it.
- **What stays sealed** is the kernel: its rules above, and its authorship of every fact.

Before any of it becomes stable, it needs an updated research doc, docs pages, e2e evals for each `next` value and its failure modes, and a changeset.
