---
issue: "None (maintainer-requested research)"
status: proposed
last_updated: "2026-11-13"
---

# Building eve with eve

## Motivation

We like adding new ways for a user to customize how eve works.

Today, we have a default compaction behavior and a few levers you can pull to customize it, but it'd be nice if users could customize it further. That gets tricky fast. You can think of compaction as two functions, one that says _when_ to compact and one that says _how_, but then you want to strip large tool results before the model ever sees them, and it's no longer clear how the pieces compose.

`defineMemory` shows the same challenge from another angle. It adds tools, it reacts to things that happen in the session, and it puts recalled messages in front of the model. Tools and hooks could already be added directly, but before `defineMemory` there was no way to touch model-facing context like that. If a user wants to do something similar that has nothing to do with memory, they're stuck.

That leads to the first question: could even a feature as complex as memory be built in user space? What about the tool catalog, `ask_question`, or the subagent tool? And the second question: if we got there, what would be left of eve? What makes an eve program more than a durable `while` loop with arbitrary code inside it, and what can we still guarantee about every program, no matter what a user puts on top?

This doc's answer is to build eve with eve. Every feature eve ships should be expressible with the same pieces a user gets, and when something can't be, that's a sign a building block is missing.

## Summary

- Can a user change any part of how a turn runs?
  - Yes, with `defineHarness`. A harness is a stack of layers, and each layer changes only the stages it cares about: the model, the instructions, the tools, the context each turn starts with, what happens next, how the history gets compacted, what goes into each model request, what an incoming message does, and what to do when something happens.
- What's left of eve?
  - A small kernel. It writes every fact to the session's stream, gates every tool call, binds every call to the person who asked for it, and tracks usage. No harness can get around any of that, so clients and safety guarantees work the same for every agent.
- What does everything compile down to?
  - Harness layers. A tool file, an instructions file, a hook, and memory are all sugar for a layer, and an agent is one ordered list of them. Agents defined in code get the same model: `defineAgent` holds identity and config, and everything the agent contains goes in its harness.
- Can eve's own features be written this way?
  - Mostly. The model loop, compaction, tool search, tasks, approvals, memory, and multiplayer steering all break down into kernel pieces plus a harness layer or a tool.
- What about tools that have to wait, like `ask_question` or the subagent tool?
  - Probably, with a few host-neutral primitives that roughly mirror Workflow's (a place an answer can arrive, a timer, and a way to remember results). This part is the most speculative.

## Part 1: The loop

At its simplest, a harness is a while loop:

```ts
while (true) {
  const response = await callModel({ model, system, tools, history });
  history.push(...response.messages);
  if (response.toolCalls.length === 0) return response.text;
  for (const call of response.toolCalls) history.push(await runTool(call));
}
```

There are really only a few kinds of things you'd want to change here. Some of them shape the model call itself: which model to use, its instructions, its tools, and the messages it reads. One of them is what happens after each model call: call the model again, call some tools, or end the turn. Two are about the conversation over time: how the history gets shrunk when it's too long, and what a message does when it arrives while a turn is already running. And sometimes you just want to react when something happens, without changing anything about the loop.

If a user can control all of those, there's nothing stopping them from implementing any of our existing features from scratch.

We can't hand over the while loop itself, though. eve sessions are long-running and multiplayer. They need to be durable, approvals need to belong to the right person, and clients need every session's stream to have the same shape so they can render it. If a user could inject arbitrary code into the loop, none of that could be guaranteed.

So eve splits into three layers. The kernel is the loop itself, and it can't be customized. The harness is everything a user can change, expressed as decisions the kernel asks for at fixed points. The host is where the session runs and where its data lives, which can be Workflow, a single process, or a World.

## Part 2: What a harness can change

A harness layer is an object whose keys are _stages_. Every stage is optional, and a stage a layer leaves out is whatever the layers below it say. eve's own behavior is the bottom of the stack.

Each stage gets a `ctx` describing the session and a `below` function that returns what the layers underneath would have done. You can return that unchanged, adjust it, or ignore it entirely, in which case nothing underneath runs. That's the whole composition model, and it's what makes it possible to say "whatever eve would do, except...".

Here they are, simplest first.

### Instructions

`instructions` decides what's in the system prompt. Passing a string adds a line:

```ts title="agent/harness.ts"
import { defineHarness } from "eve/experimental/harness";

export default defineHarness({
  instructions: "Answer in one paragraph.",
});
```

Passing a function lets you look at the prompt's parts and change them. Order matters here. Every part of eve's prompt has a fixed slot (the agent's instruction files, then the workspace, the skills listing, dynamic instructions, and eve's notes on tasks and approvals), so what files add doesn't depend on the order they happened to load in. A function sees those parts in that order.

<details>
<summary>Example: a read-only note for viewers</summary>

```ts
const viewer = (ctx: HarnessContext) => ctx.session.auth.current?.attributes?.role === "viewer";

export default defineHarness({
  instructions: async (ctx, below) =>
    viewer(ctx) ? [...(await below()), "You can read but not change anything."] : below(),
});
```

</details>

### Tools

`tools` decides what the model can call. A map adds tools, and a function filters, reorders, or rewords the tools underneath.

This stage runs before eve builds its tool search (`eve__search` and `eve__tool`), so a tool you drop here can't be found by searching either. A tool keeps its own approval policy whatever you do to it, and its name, schema, and code always come from its definition.

<details>
<summary>Example: viewers can't use tools that write</summary>

```ts
export default defineHarness({
  tools: async (ctx, below) =>
    viewer(ctx) ? new Map([...(await below())].filter(([name]) => !WRITES.has(name))) : below(),
});
```

</details>

### Next

`next` decides what happens after each model call. It returns an action, and the kernel carries it out:

```ts
type HarnessAction =
  | { model: { note?: string } } // call the model again, after showing it a note
  | { call: { tool: string; input?: JsonValue }[] } // call some tools yourself
  | { settle: JsonValue } // end the turn with this reply
  | { fail: string } // end the turn as failed
  | { wait: { tasks: string[] } }; // wait for running tasks
```

eve's own `next` is about as simple as you'd expect. If the model hasn't read its tools' results yet, call it again. If tasks are still running, wait for them. Otherwise, settle the turn with what the model said.

`next` gets asked at four points: when new input arrives, right after each model call, after calls the harness made itself have finished, and when a task's result comes in. It sees the turn's calls in `ctx.calls` and its running tasks in `ctx.tasks`, so it can wait on work it started and pick up the results. The third point is what makes slash commands work. A harness can see `/release 1.2.0`, call the `release` tool, and settle the turn from its result without the model ever running. The harness's calls go through the same approval and sign-in process the model's do. They're marked as coming from the harness in the session's stream, and the model later reads them as a framework message saying the harness ran the call and what came back, so it never sees tool calls it didn't make.

<details>
<summary>Example: a critic that sends the model back</summary>

```ts
export default defineHarness({
  next: async (ctx, below) => {
    const action = await below();
    if (!("settle" in action) || ctx.continuations > 0) return action;
    return /\[\d+\]/.test(String(action.settle))
      ? action
      : { model: { note: "Cite a source for each claim, like [1]." } };
  },
});
```

It asks eve what it would do. If eve wants to end the turn and the answer has no citations, it sends the model back with a note instead. The rejected answer stays in the history right before the note, so the model revises with both in view.

If a check like this needs real work, such as asking another model whether the answer holds up, wrap it in `ctx.memo(key, fn)`. That runs `fn` once per key and remembers the result, so a retried step doesn't pay for the check twice.

</details>

<details>
<summary>Example: a slash command that runs a gated tool</summary>

```ts
export default defineHarness({
  next: (ctx, below) => {
    const version = /^\/release (\S+)$/.exec(ctx.input)?.[1];
    if (version === undefined) return below();
    const release = ctx.calls.find((call) => call.tool === "release");
    if (release === undefined) return { call: [{ tool: "release", input: { version } }] };
    if (release.status !== "settled") return below();
    return release.outcome === "completed"
      ? { settle: `Released ${version}: ${(release.output as { url: string }).url}` }
      : { fail: `The release was ${release.outcome}.` };
  },
});
```

The model never runs. If `release` needs approval, the turn waits for it, and once someone approves, the harness reads the result and settles the turn.

</details>

### Compact

`compact` decides when and how the session's history gets rewritten to fit. eve's own version summarizes when the next call would pass the threshold in `agent.ts`, or when someone calls `session.compact()`. A layer gets `ctx.tokens` and `ctx.threshold`, `ctx.pastThreshold` (whether eve's own check says it's time, which also accounts for instructions and tools), `ctx.requested`, and `ctx.summarize()`, which is eve's summarizer.

Whatever `compact` returns becomes the session's history from then on. The kernel records it as a compaction, so clients see it happen and memory gets a chance to capture what's about to disappear.

<details>
<summary>Example: your trigger with eve's summarizer, or eve's trigger with your summary</summary>

```ts
// compact earlier than eve would
export default defineHarness({
  compact: (ctx) => (ctx.tokens > 0.6 * ctx.threshold ? ctx.summarize() : undefined),
});

// compact when eve would, but keep the last ten messages word for word
export default defineHarness({
  compact: async (ctx) =>
    ctx.pastThreshold || ctx.requested
      ? [...(await ctx.summarize(ctx.history.slice(0, -10))), ...ctx.history.slice(-10)]
      : undefined,
});
```

</details>

### Context

Before going further, it helps to know how text reaches the model. There are four ways. The system prompt is sent on every call. The history is the conversation itself. Context is attached to a turn, and sits right before that turn's input on every call. And announcements are messages eve adds to the conversation, then adds again when their content changes (tool search's listing of available tools is one). Put together, a request looks like this:

```text
tools
system                        instructions and eve's notes, in their slots
messages
  [compaction summary]        history
  ── an earlier turn ──
  announcements made then     history: written once, then left alone
  context for that turn       rebuilt on every call, in the same spot
  the turn's input            history
  assistant messages, results history
  ── the current turn ──
  new or changed announcements
  context for this turn       rebuilt on every call, in the same spot
  the current input           history
```

The layout is designed to keep the prompt cache hitting. eve never goes back and edits an earlier announcement, and context stays locked to its spot.

The `context` stage decides what a turn starts with. The kernel calls it once, when the turn starts, and saves what it returns under that turn. From then on, every model call places each turn's saved context right before that turn's input, in the same spot earlier calls saw it. That's true in later turns, after a deploy, and in another process. When a compaction removes a turn's input, its context moves to just after the summary, and a clear starts over.

Context never becomes part of the history. That's what you want for things like memory's recall, where the recalled messages aren't something anyone said, and where a later turn might recall something different.

<details>
<summary>Example: remind the model of the open ticket at the start of every turn</summary>

```ts
export default defineHarness({
  context: async (ctx, below) => {
    const ticket = await openTicketFor(ctx.session.id);
    return ticket === undefined
      ? below()
      : [...(await below()), { role: "user", content: `Open ticket: ${ticket.summary}` }];
  },
});
```

The lookup runs once per turn, not on every model call, and earlier turns keep the reminder they started with, so the cached prefix never changes.

</details>

### Request

`request` is the last chance to change a model call before it's sent. It sees the whole request laid out as above (the instructions, the messages, and the tools) and returns the one to send. Whatever it returns is used for that one call and then thrown away, so it never changes the session's history. That makes it the right place for per-call adjustments, and also a place where you can accidentally break caching, since anything you change early in the messages invalidates everything after it.

Most harnesses have a hook like this. LangGraph's pre-model hook, OpenAI's `call_model_input_filter`, and the AI SDK's `prepareStep` are all versions of it. They differ on whether what you return is saved. In eve it never is, and saving is `compact`'s job.

<details>
<summary>Example: pinned facts the model sees but the history never keeps</summary>

```ts
export default defineHarness({
  request: async (ctx, below) => {
    const request = await below();
    const pinned = { role: "user", content: `Pinned: ${await pinnedFacts(ctx.session.id)}` };
    return { ...request, messages: [...request.messages, pinned] };
  },
});
```

</details>

<details>
<summary>Example: trimming big tool results from older turns</summary>

```ts
export default defineHarness({
  request: async (ctx, below) => {
    const request = await below();
    return { ...request, messages: trimOldToolResults(request.messages, { keepTurns: 2 }) };
  },
});
```

The trimmed results stay in the history. The model just doesn't read them on this call.

</details>

### Admit

`admit` answers a multiplayer question: when a message arrives, what should it do? It can join the turn that's running, wait for that turn to end, start a turn of its own, or be dropped. `ctx.delivery` describes the message, including who sent it.

This stage touches something safety-related, so it works a little differently. A harness can only make eve's rule stricter, never looser, and the kernel enforces that after the harness decides. A turn that's waiting on its own person (for an approval, say) still hears from them, or it could never finish. The decision and its reason go into the session's stream, so a client can tell someone why their message is waiting.

<details>
<summary>Example: messages wait while a deploy is running</summary>

```ts
export default defineHarness({
  admit: (ctx, below) =>
    ctx.calls.some((call) => call.tool === "deploy" && call.status !== "settled")
      ? { action: "queue", reason: "A deploy is running; I'll read this once it's done." }
      : below(),
});
```

</details>

### Model

`model` picks the model for each call. eve's own answer is the agent's model, including a dynamic one. A layer can switch models for a particular call, like a retry after a critic's note.

<details>
<summary>Example: a bigger model for retries and long conversations</summary>

```ts
export default defineHarness({
  model: (ctx, below) =>
    ctx.continuations > 0 || ctx.size.tokens > 100_000 ? "anthropic/claude-opus-5.5" : below(),
});
```

</details>

### On

`on` reacts to what happens in the session, after it's been written to the stream. It's what a hook file is today, and it's how memory captures after a turn. Unlike the other stages, `on` handlers don't wrap each other. Every layer's handlers run, because reacting to an event is something many layers might want to do at once. An `on` handler can't write facts itself. It can ask the session to do things, like cancel a turn, and the kernel carries that out.

<details>
<summary>Example: post to a channel when a deploy finishes</summary>

```ts
export default defineHarness({
  on: {
    "call.settled": async (event, ctx) => {
      const call = ctx.calls.find((entry) => entry.callId === event.data.callId);
      if (call?.tool === "deploy") await notifyDeploys(call);
    },
  },
});
```

</details>

### How layers stack

A stage only ever wraps the same stage below it. The exceptions are values and `on` handlers, which are collected from every layer instead (two layers can't add a tool with the same name, and the first one keeps it). When one stage needs another, it asks for it through `ctx.harness`, which always reflects the whole stack. For example, eve's own `next` needs a request to make a model call, so it asks for one, and it gets whatever the stack's `instructions`, `tools`, and `request` produce. That's why the pinned-facts example works without knowing anything about the loop.

The stack comes from files. The agent's `harness.ts` is on top, then each mounted extension's `harness.ts` in alphabetical order by namespace, then eve. So an extension can ship a slash command just by including a harness, and the agent doesn't have to change anything. If you want to list the stack yourself, you can pass an array, outermost first:

```ts
export default defineHarness([critic, deployCommands, { request: pinFacts }]);
```

And if you want to start from scratch, `extends: false` removes everything underneath, eve included. A harness like that still gets the agent's own tools and instructions, but none of eve's additions (the skills listing, task tools, and tool search), and it has to define `next`, since there's no loop underneath to fall back on.

### What the kernel still owns

No matter what a harness does, the kernel is the only thing that writes facts to the session's stream. Every call, whether the model made it or a harness did, goes through the same approval and sign-in checks, and runs as the person who asked for it. Someone who approves a call is giving consent, not lending their identity. Usage is tracked on every model call, a turn can't finish while its tasks are still running, and a turn with an output schema can only finish with a value that matches it. Work that should outlive a turn ("start the build and I'll keep chatting") belongs to something that outlives it, like a child session, which reports back with a new message that starts its own turn.

The kernel also checks what a harness decides before acting on it. A harness can't send the model back when there's nothing new for it to read, add more than ten notes in a turn, make more than fifty calls, or end a turn while tasks run. When it tries, the turn fails with a specific error code, which beats quietly overriding the harness and letting it believe it's in charge.

## Part 3: What everything compiles down to

So far a harness looks like something you add on top of an agent. It's simpler than that. Everything an agent contains is a harness layer.

A tool file is `defineHarness({ tools: { weather } })`. An instructions file is `{ instructions: "..." }`. A hook file is an `on` layer. A dynamic tool file is a `tools` function, and memory is a layer that uses several stages at once (Part 4 shows what that looks like). eve's own features are layers too, and they sit at the bottom of the stack. So an agent, whether it came from files or from code, is one ordered list of layers.

Inside eve, that list is what the kernel runs, and each entry carries a little more than a public layer does. It has a stable id (a file's path, or an explicit id in code), which is what lets the kernel remember the result of a dynamic `tools` function and check that a call waiting for approval still matches the tool the model was offered. Some layers also have an install step, like connections registering themselves or skills writing their files into the sandbox. And each one knows what kind of file it came from, so a collision between two tools can be reported against the files that caused it. This internal type is what `Definition` grows into. Users never see it.

<details>
<summary>What programming directly against the kernel would look like</summary>

Roughly, and with internal types simplified, a kernel program is just the list:

```ts
const program: KernelProgram = [
  layer("tools/weather.ts", { tools: { weather } }),
  layer("instructions.md", { instructions: readFile("instructions.md") }),
  layer("hooks/notify.ts", { on: { "turn.settled": notify } }),
  layer("memory.ts", { tools: memoryTools, context: recall, compact: captureFirst }),
  layer("harness.ts", { next: critic, request: pinFacts }),
  ...eve.layers(), // eve's loop, compaction, task tools, tool search, admission
];
```

The kernel runs it like this. Every time something arrives, it applies the input and asks the stack's `admit` what it does. When a turn starts, it asks `context` what the turn starts with and saves the answer. While a turn is open, it asks `next` for an action. For a model call, it collects the layers' tools and instructions and every turn's saved context into a draft request, asks `compact` whether to rewrite the history first, asks `request` for the final version, picks a model with `model`, calls the model, writes the facts, and runs every `on` handler. For a tool call, it runs the gate. Then it asks `next` again.

</details>

Is there anything this lower level can do that `defineHarness` can't? Two things, and neither is a safety hole. It can add announcements directly. Those are how eve tells the model about things that change over a session, like the tools tool search can reach, and they're tied closely enough to eve's own features that they stay internal. And it reads eve's internal view of the session, while a harness reads the public one that hooks and dynamic files also see. The internal view changes far more often than a public API should, so that stays internal too.

### Agents defined in code

The same idea decides what an agent defined in code looks like. If `defineAgent` took `tools`, `instructions`, `skills`, `subagents`, and `connections` as arguments, it would need a new field for every kind of file and special rules for how they override each other. Instead, it mirrors the filesystem. `agent.ts` holds identity and runtime config, and everything else in the folder is layers, so `defineAgent` holds identity and config and everything the agent contains goes in its harness:

```ts
const chat = defineAgent({
  name: "chat",
  model: "anthropic/claude-haiku-4.5",
  sandbox: memorySandbox(),
  harness: defineHarness([
    { instructions: "You're a friendly assistant with a shell.", tools: { weather } },
    critic,
    { tools: { reviewer: subagent(reviewerAgent), ...mcp(githubServer) } },
  ]),
});
```

eve's defaults are its bottom layer here too, and `extends: false` removes them. Subagents, MCP servers, and skills each get a small helper that produces a layer. The agent's static model stays in its config, and choosing a model per call is the `model` stage.

## Part 4: Bigger things as harnesses

Memory is a good test, because it's the feature that started this. What would `defineMemory` look like as a harness?

Memory does four things. It offers tools (remember, forget). It puts recalled messages in front of the model before each turn's input. It captures what's about to be lost before a compaction, and it must block the compaction if that fails. And it captures again after every turn.

<details>
<summary>A sketch of memory as a harness layer</summary>

```ts
export default defineHarness({
  tools: { remember, forget },

  context: async (ctx, below) => [...(await below()), ...(await provider.recall(ctx.input))],

  compact: async (ctx, below) => {
    await provider.capture(ctx.history); // if this throws, the compaction doesn't happen
    return below();
  },

  on: {
    "turn.settled": async (_event, ctx) => provider.capture(ctx.history),
  },
});
```

</details>

Most of it falls out naturally. Capturing in `compact` before calling `below()` gets exactly the blocking behavior memory needs, because if the capture throws, nothing underneath runs. The tools are just tools, and the after-turn capture is an `on` handler.

Recall is the part that's easy to get wrong by hand, and it's why `context` is a stage. Recall has to run once per turn, both because it's slow and because a mid-turn change in what was recalled would change the prompt halfway through. Every turn's recall also has to show up again, word for word, in the same spot on every later call, including after a deploy, or the cached prefix silently stops matching. A `request` function could do all that, but it would have to save each turn's recall somewhere durable, find turn boundaries in the messages, and handle compactions and clears. The `context` stage does those for you, so recall is one line. With it, memory stops being a special feature and becomes a layer anyone could have written, including one that recalls every few turns (return nothing on the other turns) or captures on a different schedule.

## Part 5: Tools that wait

This part is more speculative than the rest.

The harness covers the loop, but a lot of eve's complexity lives inside tools that have to wait for something. `ask_question` waits for a person, the subagent tool waits for another agent, and a workflow tool can wait for anything. Today all of them run on Workflow, because a workflow function is the only thing that can hold a promise open across an hour-long wait and a server restart.

What they actually need is small, and it maps closely onto Workflow's own building blocks. `ctx.address` is a place an answer can arrive, like a hook. `ctx.timer` is a durable deadline, like `sleep`. `ctx.record` saves a result the first time it runs and returns the saved result after that, like a step. And `any` waits for whichever of those comes first. The difference is that these belong to eve and run on any host, so the in-process host, the browser, and the World host can all run tools that use them, with no compile step.

Here's `ask_question` written directly on them:

```ts title="agent/tools/ask_question.ts"
export default defineTool({
  description: "Ask the person a question and wait for the answer.",
  inputSchema: z.object({ question: z.string() }),
  async execute({ question }, ctx) {
    const answer = ctx.address("answer", {
      accepts: z.object({ text: z.string() }),
      from: ctx.caller,
      describe: { kind: "question", prompt: question },
    });
    const first = await any([answer.next(), ctx.turn.nextMessage()]);
    return first.handle === answer ? { answer: first.value.text } : { interrupted: true };
  },
});
```

While the tool waits, the kernel records the call as waiting and the process can forget about it. When an answer arrives, the kernel checks it against `accepts` and `from` and runs the tool again from the top. `ctx.address("answer")` returns the same address, `next()` returns the saved answer, and the tool carries on as if it had never stopped. Anything with side effects before the wait goes in `ctx.record`, the same rule Workflow has for steps, except you write it by hand.

For people, addresses don't need anything new in the protocol. They map onto the interaction facts approvals and questions already use, so older clients can answer them. Who's allowed to answer works the way approvals do today. `from` can be an audience the kernel checks up front, or a function that runs in a step like an approval's response policy. Either way, someone who doesn't qualify gets a refusal with a reason, and the address stays open for someone else.

<details>
<summary>Example: waiting for CI, with a timeout</summary>

```ts
async execute({ sha }, ctx) {
  const checks = ctx.address("checks", { accepts: CheckSuiteEvent });
  await ctx.record("subscribe", () => github.subscribe(sha, checks.url));
  const result = await any([checks.next(), ctx.timer("timeout", ctx.now + 30 * 60_000)]);
  return result.handle === checks ? result.value.conclusion : "timed out";
}
```

The address has a URL, so a webhook can deliver to it. Run as a detached call, the agent keeps talking while CI runs.

</details>

<details>
<summary>Example: a deploy that needs two different approvers</summary>

```ts
async execute({ target }, ctx) {
  const approve = ctx.address("approve", {
    accepts: z.object({ ok: z.literal(true) }),
    from: async (responder) => isOnCall(responder) || { allow: false, reason: "On-call only." },
    describe: { kind: "approval", prompt: `Deploy ${target}? Two on-call approvals needed.` },
  });
  const first = await approve.next();
  let second = await approve.next();
  while (samePerson(second.from, first.from)) {
    approve.refuse(second, "A second, different person has to approve.");
    second = await approve.next();
  }
  return await ctx.record("deploy", () => deploy(target));
}
```

Today this would need a workflow tool. Here it's an ordinary function, and the deploy runs exactly once.

</details>

Workflow is generally the nicer programming model. Every step is journaled for you and gets retries, and you can't forget to wrap a side effect. It also brings deployment pinning, because replaying a function needs the code that started it. This model replays too, so the same concern applies, but at a much smaller scale. The session loop never replays, because its state is plain data, so a session can always continue on new code. Only a tool call that was waiting when a deploy happened gets re-run, and if its code changed in a way that matters, the kernel can tell (from a fingerprint of the tool, and by checking that the re-run retraces the steps it saved) and fail that one call as interrupted, listing what it had already done. Failing a tool call is fine, since the model reads the error and decides what to do next. Failing the session loop isn't.

So workflow tools stay. If you write `"use workflow"`, your tool runs on Workflow, with its nicer model and its pinning. eve's own tools use the primitives above instead, which is what lets them run anywhere.

## Part 6: eve, built with eve

With the harness and tools that can wait, most of what eve does stops being special. Here's how each big feature breaks down.

### The model loop

The model loop is the bottom `next`. It isn't privileged. A harness that calls `below()` and adjusts the answer is the same kind of thing eve is, one layer up.

<details>
<summary>eve's next, roughly</summary>

```ts
next: (ctx) => {
  if (ctx.lastStep === undefined || ctx.unreadResults) return { model: {} };
  if (ctx.workingTasks.length > 0) return { wait: { tasks: ctx.workingTasks } };
  return ctx.outputSchema === undefined
    ? { settle: ctx.lastStep.text }
    : ctx.lastStep.output === undefined
      ? { fail: "The agent couldn't produce a result matching the requested schema." }
      : { settle: ctx.lastStep.output };
};
```

</details>

### Compaction

Compaction is the bottom `compact`: summarize when past the threshold or when asked.

### Tool search

Tool search is a `tools` layer over the finished set of tools. It offers `eve__search`, an ordinary tool that searches the set, plus `eve__tool` and `eve__skill`, and it takes deferred tools out of the model's list. `eve__tool` is the one piece that stays in the kernel. It's a _route_, meaning a call to it becomes a call to the tool it names, and the approval check needs to see the real tool.

<details>
<summary>Tool search as a layer, roughly</summary>

```ts
tools: async (ctx, below) => {
  const all = await below();
  const listed = new Map([...all].filter(([, tool]) => !tool.deferred));
  return new Map([...listed, ["eve__search", searchTool(all)], ["eve__tool", routeTo(all)]]);
},
```

</details>

### Tasks

A task is a call the turn doesn't wait on. With tools that can wait, "detached" becomes a mode of any call, and `eve__task_wait` becomes a regular tool.

<details>
<summary>eve__task_wait as a tool</summary>

```ts
execute: async ({ timeoutMs }, ctx) =>
  await any([...ctx.openCalls(), ctx.timer("timeout", ctx.now + timeoutMs), ctx.turn.nextMessage()]),
```

</details>

### Questions, approvals, and sign-in

These are all addresses. `ask_question` is the example above. An approval is an address the kernel opens before a call starts, with an audience it controls. Sign-in is an address whose URL is the OAuth callback. And `sleep` is a timer.

### The subagent tool

Today, delegating to a subagent goes through a task, a separate run for that task, and a child session, plus a special kind of tool called `serve`. If a regular tool could talk to a child session directly, it collapses into a few lines. The child is keyed, so calling again with the same task id reaches the same child, and `serve` isn't needed. Children belong to the session. A child stays alive between calls, and it ends when the model cancels it or the parent session ends, which is the same lifetime agent tasks have now. Agent tools stay detached by default, so the conversation looks the same as it does now.

<details>
<summary>The subagent tool, roughly</summary>

```ts
export default defineTool({
  description: "Ask the reviewer agent.",
  inputSchema: z.object({ message: z.string(), taskId: z.string().optional() }),
  execute: async ({ message, taskId }, ctx) =>
    await ctx.agent("reviewer", { key: taskId ?? ctx.callId }).send(message),
});
```

</details>

### Memory

Memory is the harness layer from Part 4.

### Multiplayer steering

Multiplayer steering is the bottom `admit`. The pattern for anything safety-related is that a harness picks a decision and the kernel takes whichever is stricter, the harness's or its own. Identity stays in the kernel. The person who started a turn always owns it, and only the named person can approve a call that uses their credentials.

### Hooks that continue a turn

A hook can call `ctx.continue()` today, which keeps the turn going with a note that the message was sent automatically. That's a second way of deciding "the turn goes on," next to `next`. Folding it into a `next` layer would leave `on` handlers for side effects only and one place that decides what happens next.

## Part 7: Things you can build

The fun part of having small pieces is seeing what falls out of them.

<details>
<summary>Runbooks</summary>

A fixed list of gated steps, run by the harness, with the model only writing the summary at the end.

```ts
const STEPS = ["drain_traffic", "migrate_db", "restore_traffic"] as const;

export default defineHarness({
  next: (ctx, below) => {
    if (ctx.input !== "/failover") return below();
    for (const tool of STEPS) {
      const call = ctx.calls.find((entry) => entry.tool === tool);
      if (call === undefined) return { call: [{ tool }] };
      if (call.status !== "settled") return below();
      if (call.outcome !== "completed") return { fail: `${tool} ${call.outcome}; stopped.` };
    }
    return ctx.lastStep === undefined
      ? { model: { note: "Summarize the failover for the incident channel." } }
      : below();
  },
});
```

"Migrating the database needs a second person to sign off" is just that tool's approval policy.

</details>

<details>
<summary>Test until green</summary>

```ts
export default defineHarness({
  next: async (ctx, below) => {
    const action = await below();
    if (!("settle" in action)) return action;
    const lastEdit = ctx.calls.findLastIndex((c) => c.tool === "write_file" && c.by === "model");
    const lastTest = ctx.calls.findLastIndex((c) => c.tool === "run_tests");
    if (lastEdit === -1) return action;
    if (lastTest < lastEdit) return { call: [{ tool: "run_tests" }] };
    return passed(ctx.calls[lastTest]!) || ctx.continuations >= 3
      ? action
      : { model: { note: `Tests failed:\n${failures(ctx.calls[lastTest]!)}\nFix them.` } };
  },
});
```

</details>

<details>
<summary>Parallel review</summary>

`/review` sends the diff to three reviewer subagents at once, waits for all of them, and asks the model to merge what they found. The harness sees the reviewers as tasks in `ctx.tasks`, and `next` is asked again as each result comes in.

```ts
next: (ctx, below) => {
  if (ctx.input !== "/review") return below();
  if (ctx.calls.length === 0)
    return { call: REVIEWERS.map((tool) => ({ tool, input: { message: diffOf(ctx) } })) };
  const working = ctx.tasks.filter((task) => task.status === "running");
  if (working.length > 0) return { wait: { tasks: working.map((task) => task.taskId) } };
  return { model: { note: "Combine the reviews above into one list of findings." } };
},
```

</details>

<details>
<summary>Plan, approve, execute</summary>

The harness asks for a plan on the first step with a note. A `propose_plan` tool waits on an address for the person to approve it, and until it has, the `tools` stage only offers tools that read. Plan mode stops being a product feature and becomes a small file anyone can change.

</details>

## Open questions

Where should detached calls run? A call that's just waiting costs nothing, because it's only data. A call that's actively doing heavy work needs somewhere to run. It could run inside the session's own activations, which is simpler, but an activation has a time budget, and long work that hasn't saved its progress with `record` gets redone after the session moves on. Or it could run as its own entity with its own activations, deadlines, and retries, delivering its result back through an address the way a child session does. That isolates the session from slow tools and scales out, at the cost of more coordination. The likely answer is to start in the session and move a call to its own entity when the tool says it's heavy or the host sees it outlive an activation, without tools having to care which happened.

Should a keyed child session ever go away sooner than today's agent tasks? Matching today's behavior (alive until cancelled or the parent ends) is the safe default. A child holding something expensive, like a sandbox, might want an idle timeout.

How much latency does per-message `admit` add? In-process it's nothing, but on Workflow it's a step for every batch of messages that arrive during a turn. That needs measuring, and agents that don't define `admit` should skip the step entirely.
