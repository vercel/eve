---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-10"
---

# Dynamic values

This doc records the decisions behind `defineDynamic` in the session reactions prototype ([#4616](https://github.com/vercel/eve/pull/4616), on #4602), and why the prototype deletes the AST transforms and durable callbacks that dynamic tools needed before. The reaction model itself is in [`session-reactions.md`](./session-reactions.md); this doc covers the authoring surface that sits on it. "Base" means #4602 at `91fb522fd`, which matches `main` for everything here.

## Summary

- **A dynamic value depends on the session.** `select` reads what it depends on, and `resolve` returns the value. eve calls `resolve` again only when the selection changes ([The definition](#the-definition)).
- **`resolve` is a function of its selection.** It runs outside the session's context, gets no facts, and may run again at any time, such as in another process ([`resolve` reads only its selection](#resolve-reads-only-its-selection)).
- **Few places accept one today:** a whole file in `tools/`, `skills/`, `instructions/`, `connections/`, or `subagents/`, and an agent's `model` field. A dynamic `agent.ts` is gone ([Where dynamic values go](#where-dynamic-values-go)).
- **`auto()` is a dynamic `model`, built on two internal capabilities** that authored code doesn't have: it rebuilds the model it chose from the option it recorded, and it reads the conversation before the turn when it decides ([`auto()`](#auto)).
- **The AST transforms are gone.** Code is rebuilt by calling `resolve` again, and what the model was offered is recorded and checked. Authors gain ordinary closures and lose exact replay of captured values ([Why the AST transforms are gone](#why-the-ast-transforms-are-gone)).

## The definition

```ts
// agent/tools/query.ts
import { defineDynamic, defineTool } from "eve/tools";

export default defineDynamic({
  select: (view) => view.turn?.id ?? null,
  resolve: async () =>
    Object.fromEntries((await listTables()).map((table) => [table.name, tableTool(table)])),
});
```

- **`select` is required.** It's synchronous, returns JSON, and reads the view and the session's identity. Return `null` to resolve once per session: `select: () => null`.
- **`resolve` receives the selection.** Its context holds the session's ID and auth, the channel, and an `abortSignal`. It has no `facts` and no previous result.
- **The entry point types the result.** `defineDynamic` from `eve/tools` returns tools, from `eve/skills` skills, and so on. From `eve`, it's a whole subagent, and from `eve/models`, a model. eve also validates each result by the directory it's in, so a tool returned from `skills/` fails its slot.
- **Results clear with `undefined` or `null`.** Each one contributes nothing. A resolver whose type returns nothing (`void`) is a type error, because a missing `return` would silently clear the slot.
- **The names stay `select` and `resolve`** for now. `inputs`/`render` and `deps`/`compute` were considered.

`defineHook` takes the same pair, or an `events` map, but never both. Both definers narrow one private `defineResolver`, so every authored reaction is validated the same way ([`session-reactions.md`](./session-reactions.md#hooks)). Hooks return intents, never capabilities.

### What `select` reads

`view` is the session's tables, as `eve/events` folds them, plus:

| Field           | What it is                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `view.latest`   | The position of the latest fact of each type, and `"*"` for the latest fact. Selecting a position resolves once per new fact.                                                                                                        |
| `view.turn`     | The session's latest turn, running or not, with its `id`, `status`, and `input`: the parts it opened with. Steering messages, which arrive after it starts, aren't part of `input`. Select `view.turn?.id` to resolve once per turn. |
| `view.messages` | The conversation as the model sees it. Read lazily: a step that doesn't hold the conversation, such as a task settling between turns, skips a reaction whose `select` reads it and keeps its slot.                                   |
| `view.model`    | The model the session uses, for kinds that run after the model. Hooks, memory, and the model itself throw on reading it.                                                                                                             |

`view.turn` is the one addition this doc's decisions made to the view. It's derived from the turn and delivery tables, so it reads the same in every step. That includes steps without the conversation, and steps after a compaction rewrote the messages.

### `resolve` reads only its selection

eve may call `resolve` again with a recorded selection: to rebuild code in a fresh process, after a redeploy, or to retry after a failure. So the prototype makes the contract mechanical:

- **`resolve` runs outside the session's async context.** `defineState(...).get()` and other context reads throw, naming the file and pointing at `select`: `"tools/count.ts" read session state in resolve, which reads only its selection. Read the state in select, so a change to it resolves again, or in the execute of a tool resolve returns.`
- **Effects belong in hook `events` handlers,** which run for each new fact, at least once.
- **eve's own generated resolvers are exempt.** Memory provider tools, for example, are marked internally and run in the session's context, as built-ins.

An equal result changes nothing, but an equal _declaration_ under a new selection still records the new selection. Otherwise a fresh process would rebuild a tool's code for the previous tenant.

## Where dynamic values go

A dynamic value is a hole in a definition: one reaction whose slot fills one place. Each hole is its own reaction, with its own selection and slot.

| Where                                                                                        | Status    | Lowered to                                           |
| -------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------- |
| A whole file in `tools/`, `skills/`, `instructions/`, `connections/`                         | Supported | One reaction per file, its slot the file's export    |
| A whole subagent, `subagents/<name>/agent.ts`                                                | Supported | One reaction; `null` omits the subagent              |
| `defineAgent({ model })`, in `agent.ts` and in a subagent's `agent.ts`                       | Supported | The model reaction of the agent's own session        |
| A dynamic `agent.ts`                                                                         | Removed   | Build error that points at the dynamic `model` field |
| `compaction.model`, `build`, `defaultTools`, `experimental`, `tool`                          | Static    | Read at build, or before any session exists          |
| Descriptions, `inputSchema`, connection `url`, skill `markdown`, memory `scope`, `available` | Not yet   | Each widens a field type later                       |

### The dynamic `model` field

```ts
// agent/agent.ts
import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";

export default defineAgent({
  model: defineDynamic({
    select: (view) => view.messages.some(hasImage),
    resolve: (image) => (image ? "google/gemini-3.5-flash" : "zai/glm-5.2"),
  }),
  compaction: { thresholdPercent: 80 },
});
```

`resolve` returns a model, or `{ model, reasoning?, modelContextWindowTokens?, modelOptions? }`. The settings travel with the model they describe, so `modelContextWindowTokens` and `modelOptions` beside a dynamic model are a build error. A subagent keeps its description and chooses its own model the same way: `defineAgent({ description, model: defineDynamic(...) })` runs in the subagent's session, from the subagent's own prompt.

**Why a field, not a dynamic `agent.ts`.** An earlier revision of this prototype made `agent.ts` dynamic as a whole, returning `defineAgent(...)`, and rejected dynamic fields:

- **Static fields needed a special case.** `build` or `compaction` had to sit beside `select` and `resolve`, so the definition was neither an agent nor a resolver, and the result type couldn't be narrowed by entry point.
- **`auto()` had to be spread in:** `export default auto(...)`, or `{ ...auto(...), compaction }`. Every doc and template on `main` writes `defineAgent({ model: auto(...) })`.
- **Subagents grew a dual mode.** A dynamic subagent with a static `description` chose only its model; without one, it chose the whole subagent. The field form makes that two ordinary things: a `defineAgent` whose model is dynamic, and a dynamic subagent.

The field form keeps the property the whole-file form was after: one hole holds one coupled decision, the model and its settings, and anything that can't vary stays a static field.

### Static, dynamic, or a callback

Three different things vary, and a field's type says which one it takes:

| Kind              | When it's evaluated                                        | For                                                                                  |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Static**        | At build or deploy                                         | `build`, channels, schedules, tool names, workflow tools                             |
| **Dynamic value** | After each commit, memoized by its selection, and recorded | What the model sees, and which capabilities exist                                    |
| **Callback**      | When it's used, in context, and free to have effects       | What's needed only when something runs: `execute`, `approval`, `headers`, `getToken` |

The rule of thumb: if it changes what the model sees, it's a dynamic value; if it's needed only when something executes, it's a callback. A connection's `url` sits on the line: it's needed only when a request goes out, but which server the session uses decides which tools discovery finds, so a URL that varies per tenant belongs in a dynamic value.

### Several holes in one definition

The design allows it, and the prototype doesn't yet:

```ts
export default defineTool({
  description: defineDynamic({ select: team, resolve: describeServices }),
  inputSchema: defineDynamic({ select: (view) => view.turn?.id ?? null, resolve: serviceSchema }),
  execute: deploy,
});
```

- **They resolve independently,** each when its own selection changes.
- **They stay consistent.** Every hole is evaluated after the same commit, against the same view.
- **Siblings can't read each other.** Holes of one kind see only earlier kinds, so there's still no dependency graph.
- **They're validated together.** The kind's normalizer checks the filled definition, and a hole that fails withdraws the whole entity: the tool isn't offered.
- **Two holes that need the same data fetch it twice.** One decision belongs in one hole, which is why the model is one selection object. When several fields come from one fetch, the whole file is the hole.

### Widening later

Widening a field from `T` to `T | Dynamic<T>` is additive for authors: every static definition still type-checks and behaves the same. Narrowing would break, so the prototype starts narrow. Widening isn't free on the reading side:

- **Code that reads definitions** sees the wider type: extension contracts, eve's own readers, and tests or apps that inspect `defineTool(...).description`. The definers preserve literal types, so a static author still sees `string`.
- **Client-facing schemas.** Agent info publishes tool and subagent descriptions as strings. A dynamic one has no static value, and making a required field optional breaks clients.
- **Build-time readers inside eve.** Tool search over descriptions, name-collision checks, and the agent-info catalog read some fields before any session exists.

The costs are eve's, field by field, plus agent info in some cases. `available` for subagents and remote agents is the likely first widening: it restores authenticated remote agents that vary per session ([What changes for authors](#what-changes-for-authors)).

## Slots, restores, and redeploys

Each reaction writes one slot in the session's durable state. A slot holds a digest of the selection, the JSON value, the position it changed at, the runtime revision that resolved it, and, after a failure, the error. Code that JSON can't carry lives in a process-local cache of 1,024 sessions.

- **Data is the value.** Instructions, a subagent's description and model, a gateway model ID, and recall need nothing rebuilt.
- **Code is a cache.** Tools, skill packages with files, connections, and provider model objects record the selection that produced them. A fresh process rebuilds them before the step's first commit.
- **A failure is memoized.** The slot keeps the failed selection's digest and the error, so the reaction retries when the selection or the revision changes, not on every commit. A failed model selection fails the model call that needs it, rather than an earlier commit that had nothing to choose from yet.
- **Redeploys re-resolve code and failures only.** A data slot keeps its value until its selection changes, so a redeploy doesn't re-run every reaction in every session. A code slot that a fresh process rebuilt under the new revision is current, so it isn't resolved a second time after the first commit.

### Rebuilding code

```text
step in a fresh process
  restore ─▶ each slot with code and no live value in this process
               ├─ the reaction has rebuild: rebuild(recorded value)          (eve's own, e.g. auto())
               └─ otherwise: resolve(recorded selection)
                     ├─ the result's JSON equals the recorded value ─▶ use the new code
                     └─ it differs ─▶ the kind's drift policy
```

**Drift policies,** when a rebuilt result differs from what the session recorded:

| Kind                     | Policy                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tools                    | Fail closed. The recorded declarations stay offered. A changed or missing tool's calls fail with `Tool "count" changed since it was offered.`, parked approvals included. A rebuilt tool that wasn't offered is omitted. |
| Model                    | Fail closed. The slot is withdrawn with `The model changed since this session chose it: …`, so the model call fails until the selection changes. The session never switches models silently.                             |
| Connections, skill files | Open. The rebuilt result replaces the recorded one, with a warning.                                                                                                                                                      |

The tool check compares declarations: name, description, and schemas. It can't see a captured value that changed while the declaration stayed the same ([What we gave up](#what-we-gave-up)).

## `auto()`

`auto()` is a dynamic `model` with options, and every doc on `main` reads unchanged again:

```ts
import { defineAgent } from "eve";
import { auto } from "eve/models";

export default defineAgent({
  model: auto({
    fallback: "anthropic/claude-sonnet-5",
    options: {
      "openai/gpt-6-sol": "Difficult reasoning and engineering tasks",
      deep: {
        model: anthropic("claude-opus-5"),
        description: "Long investigations across many files",
        reasoning: "high",
        modelContextWindowTokens: 1_000_000,
      },
    },
  }),
});
```

An option is a model ID with a description, or a model selection with one, so an option can carry its context window and provider options. Before, a fixture wrapped `auto()` to add them. A wrapper would now lose what `auto()` records, so options take them directly.

| Behavior                                     | `main`                                                | Prototype                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| When it decides                              | The turn's first `step.started`                       | After the turn's first commit that holds the conversation                                                    |
| How often                                    | Once per turn: the choice is stored per turn          | Once per turn: the selection is `{ turnId, input }`                                                          |
| Through tool calls, steering, and compaction | Reused                                                | Reused: none of them changes the selection                                                                   |
| In a fresh process                           | The stored key maps to the model; no decision         | The recorded option rebuilds the model; no decision                                                          |
| What it reads                                | Up to 8 text messages through the latest user message | The turn's input, after up to 7 messages before it                                                           |
| A failed decision                            | Fallback, or the turn fails                           | Fallback, recorded like any choice, or the model call fails                                                  |
| An option a redeploy removes or changes      | Not checked                                           | A provider object's model call fails until the next turn; a gateway ID is data, and keeps its recorded model |

Two internal capabilities make this work, and neither is available to an authored `resolve`:

- **`rebuild`.** The model slot records the option a turn chose, and a fresh process rebuilds the model from the option table without calling the decision model.
- **The conversation in `choose`.** The selection holds only the turn and its input, so it can't change mid-turn. Context from before the turn comes from the conversation when `auto()` decides. That's safe only because `rebuild` guarantees the decision never runs again for the same selection.

The view can't supply that context itself: it prunes earlier turns, and the messages change under compaction. A selection that read them would change mid-turn and decide again.

**What an author can write instead:**

```ts
import { decide } from "eve/ai";
import { defineDynamic } from "eve/models";

export default defineAgent({
  model: defineDynamic({
    select: (view) => (view.turn === null ? null : { turn: view.turn.id, input: view.turn.input }),
    resolve: async ({ input }) => {
      const { answers } = await decide({ state: { input }, questions: { tier: TIER } });
      return answers.tier.choice === "hard" ? "openai/gpt-6-sol" : "openai/gpt-6-luna";
    },
  }),
});
```

- **With gateway model IDs, it's equivalent:** once per turn, and the slot is data, so a fresh process never calls `resolve` again.
- **With provider objects, it's subtly worse.** A fresh process calls `resolve` again, which decides again: one decision call per such step. If the decision differs, the model drift policy fails the call. Local development runs in one process, so it never shows.
- **Context before the turn has to be in the selection,** which changes under compaction, so the turn can decide again.

The prototype leaves this as is. Three ways to close the gap later, in order of cost:

1. **A development-mode cold check,** like React's StrictMode: `eve dev` rebuilds each code slot once from its recorded selection, and warns when the result differs, or when the rebuild called `decide()`. The `EVE_REACTIONS_COLD=1` test seam already does the rebuild.
2. **Recording `decide()` answers** in the slot of the `resolve` that called them, and replaying them on a rebuild.
3. **A public `rebuild`.** It isn't just one more field: for it to be useful, the author decides what's recorded, so `resolve` returns data and `rebuild` builds code from it. That's the `load`/`build` split the prototype set aside as too much API.

## Why the AST transforms are gone

### What they did

On base, a dynamic resolver was bound to an event key. A `session.started` resolver ran once per session, and its result was persisted, because that event never recurs. A closure can't be persisted, so base reconstructed each callback from source:

```ts
// agent/tools/query.ts, as authored
resolve: async () => {
  const table = await pickTable();
  return {
    query: defineTool({
      description: `Query ${table}`,
      execute: async (input) => run(table, input), // `run` is a module import
    }),
  };
};
```

```ts
// after the bundler transform (simplified)
function __eve_execute_0(__closure, input) { // hoisted, with a stable identity
  const { table } = __closure;
  return run(table, input); // module references stay references
}
// …
execute: __eveStamp(__eve_execute_0, { table }), // the snapshot { table } persists as JSON
```

```text
first resolve (session.started)
  ├─ declarations ──────────────────────────▶ persisted: what the model saw
  ├─ closure snapshot { table: "orders" } ──▶ persisted, per callback phase
  └─ __eve_execute_0 ───────────────────────▶ in-process registry, keyed by
                                               session, scope, resolver, tool, and phase
later step, same process:  registry hit ─▶ __eve_execute_0({ table: "orders" }, input)
later step, fresh process: registry miss ─▶ re-run the resolver only to register the bodies
                                           (its results aren't offered)
                           ─▶ __eve_execute_0(persisted { table: "orders" }, input)
```

- **`dynamic-tool-transform.ts` (484 lines) and `dynamic-tool-ast-references.ts` (429)** hoisted every callback phase: `execute`, `approval`, `approvalKey`, three label phases, `toModelOutput`, and the input and output schemas. They worked out which identifiers were locals to capture and which were module references to leave alone, across destructuring, loops, computed keys, and TypeScript expressions.
- **`durable-callbacks.ts` (320) and `durable-schema.ts` (70)** stamped, validated, persisted, registered, and replayed the snapshots, and exported `defineDurableCallback` and `defineDurableSchema` for code the transform couldn't reach.
- **`dynamic-remote-agent-transform.ts` (170)** hoisted dynamic remote agents' `auth` and `headers` into registered factories, so a persisted subagent selection held only a function ID, never credentials.
- **Rebinding** (`dynamic-tool-rebind.ts`, a manifest flag, and the rebind paths in `context/dynamic-tool-lifecycle.ts`) re-ran resolvers to register bodies: strictly for eve's own resolvers, and best effort for authored ones.

Not counting the lifecycle code, that's about 1,500 lines of source and 2,950 of tests, and a transform in every build.

### Why reactions don't need them

1. **A result is current state, not history.** A reaction's `resolve` may run again whenever its selection asks for it, so nothing has to replay one event's closures exactly. Rebuilding is calling `resolve` with the recorded selection.
2. **What must stay stable is recorded and checked.** That's what the model was offered: the declarations, compared on rebuild, with a drift policy. The closures need to belong to the tool the model saw, not to be the originals byte for byte.
3. **Closures stay ordinary.** Nothing is serialized, so a closure can hold a client, an SDK instance, or a schema in a local variable.
4. **Remote-agent credentials don't need hoisting.** Dynamic remote agents can't carry `auth` or `headers`. An authenticated remote agent is static, so its credentials are module-level callbacks, and `available` would let one vary per session.

### Where it nets out differently: behavior

| Case                                                                                          | Base                                                                                                                                                       | Prototype                                                                                                       |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A closure over a client: `const gh = new Octokit({ auth })`, used in `execute`                | Rejected at resolution: `has a non-serializable capture`. The author builds the client inside `execute` and captures only its options                      | Works                                                                                                           |
| A helper: `execute: makeExecutor(row)`                                                        | Call expressions aren't transformed, so the tool has no durable descriptor and is rejected                                                                 | Works                                                                                                           |
| A schema in a resolver-local variable                                                         | Rejected: a non-serializable capture. The schema has to be inline or module-level                                                                          | Works                                                                                                           |
| Tools returned by an installed package                                                        | Every callback and live schema wrapped in `defineDurableCallback` / `defineDurableSchema`, with values in `closure`, or rebuilt with `eve extension build` | Plain `defineTool()`. Both helpers are deleted                                                                  |
| A captured secret: `const token = await mintToken(scope)`, used in `execute`                  | The token is JSON, so it's persisted in the session's durable state as part of the closure snapshot                                                        | Held only in process memory. A fresh process mints a new one                                                    |
| A captured value that changed, under the same declaration: an exchange rate read in `resolve` | A fresh process uses the rate the session captured                                                                                                         | A fresh process re-reads the rate. A warm one keeps the captured rate until the selection changes               |
| A declaration that changed: the table's columns differ                                        | The recorded declaration stays offered, and the call runs the current body with the closure captured for the old columns                                   | The recorded declaration stays offered, and calls fail closed with `Tool "query" changed since it was offered.` |
| A tool the resolver no longer returns: the table is dropped                                   | Calls fail closed                                                                                                                                          | Calls fail closed                                                                                               |
| A parked approval across a redeploy                                                           | Replays the latest code with the original closure                                                                                                          | Replays the rebuilt code if its declaration is unchanged; otherwise fails closed                                |
| An authenticated remote agent chosen per session                                              | Supported, through hoisted credential factories                                                                                                            | Not supported. A static remote agent, or `available` later                                                      |
| Editing a callback body, with the same tools                                                  | Safe: the new body runs with the old closure                                                                                                               | Safe: the new code runs with a rebuilt closure                                                                  |

**The changed-value row is the real cost.** Whether a session sees the new rate depends on whether a step lands in a fresh process. An author who needs a value to stay fixed for a session has two options, both visible in the code: put it in the declaration, so a change fails closed, or select what it depends on, so a change resolves again everywhere. The development-mode cold check would surface the difference locally ([`auto()`](#auto)).

### Where it nets out differently: performance

| Cost                      | Base                                                                                                                                                                                                               | Prototype                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Build                     | The transform parses every module that imports `defineTool` or `defineWorkflowTool`. In this repo's fixtures and extensions, that's 164 modules, 0.6 ms each, and the output is 1.7× the source (153 KB to 259 KB) | Nothing                                                                          |
| Resolution                | Each callback phase's closure is stamped, parsed as JSON, and registered                                                                                                                                           | One canonical digest of the declarations                                         |
| Durable state             | Declarations, plus each callback phase's closure snapshot, in session, turn, or step keys per resolver                                                                                                             | Declarations, plus the selection for slots with code, once per reaction          |
| A step in a fresh process | The resolver re-runs once to register bodies                                                                                                                                                                       | The resolver re-runs once to rebuild. Same I/O                                   |
| A redeploy                | Session-scoped resolvers re-run when the revision changes                                                                                                                                                          | Slots with code rebuild once under the new revision, and data slots don't re-run |
| Each model call           | Every `step.started` resolver runs, and every connection resolver                                                                                                                                                  | Each reaction's `select` runs after each commit; `resolve` only on a change      |

The build numbers are from running base's `transformDynamicToolExecute` over the repo's e2e fixtures and extensions, single-threaded on the development machine. Durable-state sizes weren't measured.

The one case where base did less work: a step-scoped resolver's tools were persisted with their step and restored before the step was replayed, without running the resolver. The prototype has no step scope; a reaction that selects the latest model request rebuilds its code in a fresh process like any other.

### What we gave up

- **Exact replay of captured values** across process boundaries ([behavior](#where-it-nets-out-differently-behavior)).
- **Dynamic remote agents with credentials,** until `available`.
- **A guarantee about non-declaration data.** The tool drift check can't see that a captured value changed under the same declaration. Base guaranteed it by construction, and the prototype only by convention: `resolve` is a function of its selection.

## What changes for authors

The prototype ships as a hard break: the old shapes fail the build, with no alias and no codemod.

| Before                                                   | After                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `defineDynamic({ events: { "session.started": h } })`    | `defineDynamic({ select: () => null, resolve: h })`                                    |
| `"turn.started"`, `"step.started"` keys                  | `select: (view) => view.turn?.id ?? null`, or `view.latest["model.requested"]`         |
| `ctx.messages` in a handler                              | `view.messages` in `select`                                                            |
| `defineState(...)` read or written in a handler          | Read in `select`; write from a hook's `events` handler                                 |
| `defineAgent({ model: defineDynamic({ events }) })`      | `defineAgent({ model: defineDynamic({ select, resolve }) })`, from `eve/models`        |
| `model: auto(...)`                                       | Unchanged                                                                              |
| `defineDurableCallback`, `defineDurableSchema`           | Deleted: write plain `defineTool()`                                                    |
| A dynamic remote agent with `auth` or `headers`          | A static remote agent                                                                  |
| A dynamic subagent with a static `description` beside it | `defineAgent({ description, model: defineDynamic(...) })`, or a whole dynamic subagent |

The repo's fixtures, extension packages, templates, and apps are migrated in #4616. Public docs aren't yet.

## Open questions

1. **Drift for connections and skills.** They overwrite with a warning. Should they fail closed like tools and the model, and what does failing closed mean for a connection whose server listed different tools?
2. **The development-mode cold check.** Worth building before the API ships, so the warm/cold gap is visible locally?
3. **Recording `decide()`.** Is call identity inside a `resolve` stable enough to replay answers, given `decide()` can be called conditionally?
4. **`available` first?** It's the widening with the clearest payoff: authenticated remote agents per session, and optional subagents without a whole dynamic file.
5. **The turn's input.** `view.turn.input` counts deliveries admitted before the turn started as its input. Is that the right rule for queued messages a turn consumes together, and should memory recall and capture move to it instead of inferring the input from message roles?
