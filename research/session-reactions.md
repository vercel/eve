---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-16"
---

# Dynamic values and hooks as functions

An eve agent can change during a session. Its model, tools, skills, instructions, connections, and
subagents can depend on who is calling and what the conversation says, and hooks run code as the
session progresses. This plan proposes one way to write all of them.

Today a dynamic value is a set of handlers on lifecycle events, and that has three costs:

- **Each kind has its own rules.** Models and tools can update before every model call; skills,
  instructions, connections, and subagents only when a session or turn starts. Which result wins
  when several events fire, what a steering message changes, and what happens when a handler
  throws all differ by kind.
- **Surviving a restart takes a compiler.** A session can continue in another process, and a
  dynamic tool's callback has to be rebuilt there. eve rewrites authored callbacks at build time to
  save what they capture, so authors have to write callbacks the compiler understands.
- **Hooks can watch, but can barely act.** Cancelling the turn through a callback is the only
  command a hook has. A hook that throws is logged and the turn continues, so it can't enforce a
  check.

The plan replaces the handlers with one function that eve runs before each model call, and adds
`ctx.oncePer` for the work that should happen once:

```ts
// agent/tools/crm.ts
export default defineDynamic(async (ctx) => {
  const tenantId = ctx.session.auth.current?.attributes.tenantId;
  if (!tenantId) return null;
  const rows = await ctx.oncePer(tenantId, () => db.crmTools(tenantId)); // once per tenant
  return Object.fromEntries(rows.map((row) => [row.slug, crmTool(row)]));
});
```

eve keeps the rows, not the tools. After a restart, the function runs again, `ctx.oncePer` returns
the saved rows without querying the database, and `crmTool` builds the same tools with ordinary
code. Nothing is compiled. Hooks get the same function form, and return commands such as
`cancel()` and `compact()`.

## Background

- A **session** is one durable conversation with an agent. It runs in **turns**: the agent reads
  new input, then makes one or more **model calls**, running the tools the model asks for in
  between.
- A **dynamic value** is a capability written with `defineDynamic` instead of a static
  definition: a file in `agent/tools/`, `skills/`, `instructions/`, `connections/`, or
  `subagents/`, or the `model` field of `defineAgent`.
- A **hook** is a file in `agent/hooks/` that runs code as the session progresses: auditing,
  notifications, or enforcing a policy.
- **Sessions outlive processes.** A turn can continue in a different process after a crash or
  after waiting for an approval, and the next turn can run somewhere else entirely. Anything that
  existed only in memory, such as a tool's callback, has to be rebuilt there. This doc calls that a **cold start**.
- The session's **stream** is an ordered log of **facts** about what happened, such as
  `turn.started` and `call.settled`. Each time eve saves new facts is a **commit**. The **view**
  folds the facts into tables a client can read. All three come from v27, the session-stream
  rewrite in review.
- A session moves to a new **deployment** only while it's idle.

**Status.** [#4616](https://github.com/vercel/eve/pull/4616) prototypes this on the v27 stack,
under the name _reactions_, with a three-callback API: `select`, `record`, and `render`. This
revision replaces that API with one function and `ctx.oncePer`. The prototype's runner, retry
identities, and recovery carry over; the `oncePer` API itself isn't built yet.

## How to read this

[The main changes](#the-main-changes) each explain what happens today, what changes, and why it
helps, with the cost where there is one. Details are collapsed under each.

[When things run](#when-things-run) collects the timing and recovery rules.
[Examples from main's docs](#examples-from-mains-docs) rewrites the examples in today's guides.
[Alternatives](#alternatives) shows other designs on the same examples, and [Scope](#scope) lists
what the first change includes.

## The main changes

### 1. A dynamic value is one function

**Today.** You choose when a dynamic value runs by naming a lifecycle event, and each kind supports
different events:

| Kind                                         | Events                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| Model, tools                                 | `session.started`, `turn.started`, and `step.started` (before each model call) |
| Skills, instructions, connections, subagents | `session.started` and `turn.started`                                           |

A skill that gives the caller their team's playbook:

```ts
// agent/skills/team_playbook.ts (today)
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const team = ctx.session.auth.current?.attributes.team;
      return team && PLAYBOOKS[team] ? defineSkill({ markdown: PLAYBOOKS[team] }) : null;
    },
  },
});
```

This keeps the first caller's playbook for the whole session. To follow the current caller you'd
switch to `turn.started`, and then find that a steering message or a completed sign-in joins the
running turn without another `turn.started`. A file with handlers on several events also needs
rules for which result wins.

**The change.** A dynamic value is a function, and eve runs it before every model call:

```ts
// agent/skills/team_playbook.ts (proposed)
export default defineDynamic((ctx) => {
  const team = ctx.session.auth.current?.attributes.team;
  return team && PLAYBOOKS[team] ? defineSkill({ markdown: PLAYBOOKS[team] }) : null;
});
```

The function reads the session and returns the value, or `null` for none. eve compares the result
with what the last model call used and rebuilds only what changed. Every kind works the same way.

**Why it's useful.**

- One rule for every kind: no event names, no table of which kind supports which, and no
  precedence between events.
- A value follows whatever its function reads, including the current caller, a steering message,
  and a completed sign-in, because it runs before the model call that sees them.
- A model can depend on the conversation, the same way a tool can:

  ```ts
  model: defineDynamic((ctx) =>
    ctx.messages.some(hasImage) ? "google/gemini-3.5-flash" : "zai/glm-5.2",
  ),
  ```

**The cost.** The function runs before every model call, so an expensive scan of the conversation
costs that much every time. Work that doesn't need to repeat goes in a memo
([change 2](#2-ctxonceper-keeps-what-must-survive-a-restart)).

<details>
<summary>What the function can read</summary>

| Callback      | Context                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| Dynamic value | `ctx.view`, `ctx.session`, `ctx.channel`, `ctx.turn`, `ctx.messages`, `ctx.model`, `ctx.now`, `ctx.oncePer`   |
| Hook function | `ctx.view`, `ctx.session`, `ctx.channel`, `ctx.turn` (`null` before the first turn), `ctx.now`, `ctx.oncePer` |
| Event handler | The hook context without `ctx.oncePer`, plus the event and `ctx.occurrence.id`                                |
| Memo          | `fn(occurrence)` gets `occurrence.id` and `occurrence.abortSignal`, and can read the enclosing `ctx`          |

- **`ctx.view` is the same view a client folds from the stream,** so selectors from `eve/events`,
  such as `idle(view)`, give the same answer on both sides.
- **What a client doesn't have is on `ctx`.** `ctx.turn` is the turn this model call belongs to,
  as `{ id, input, status }`. `ctx.messages` is the conversation this model call will send.
  `ctx.model` is the model chosen for it, everywhere except in the `model` field itself.
- **`ctx.now` is the time of the latest commit,** so it reads the same in every process. Code that
  needs the time uses it rather than `Date.now()`.
- **Hooks never see the assembled conversation.** Their types and runtime context have no path to
  it. An event payload can still carry message content, such as a `content.completed` fact's text.

The folder or field decides what a function may return: a tools file returns tools, a skills file
a skill, and the `model` field a model with its settings. `null` or `undefined` contributes
nothing.

</details>

<details>
<summary>Other places <code>defineDynamic</code> could fit</summary>

Each of these widens a field from `T` to `T | Dynamic<T>`, so a static definition still
type-checks and adding one later doesn't break authors. The cost falls on code that reads
definitions, such as agent info and build-time name checks.

| Place                                                                        | Status                                  | What it would enable                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| A whole file in `tools/`, `skills/`, `instructions/`, `connections/`         | In the prototype                        | Capabilities per caller, tenant, or conversation                      |
| A whole subagent at `subagents/<name>/` or `subagents/<name>.ts`             | In the prototype                        | Optional local and remote subagents                                   |
| `defineAgent({ model })`, at the root and in a subagent                      | In the prototype, including `auto()`    | Routing, per-plan models                                              |
| `available` on a subagent, remote agent, tool, or connection                 | Candidate; the clearest payoff          | Showing a capability per caller without making its whole file dynamic |
| A tool's or subagent's `description`                                         | Candidate                               | Wording per tenant or locale                                          |
| A tool's `inputSchema`                                                       | Candidate                               | An enum of the caller's projects or accounts                          |
| `limits`, such as `maxTokenCostUsdPerSession`                                | Candidate                               | Budgets per plan, checked before each model call                      |
| `compaction.model` and `compaction.thresholdPercent`                         | Candidate                               | Compaction that follows the chosen model's context window             |
| A connection's or remote agent's `url`                                       | Candidate                               | Endpoints per tenant. Needs a target comparison on cold starts        |
| A remote agent's `auth` and `headers`                                        | Proposed, as part of a dynamic subagent | Credentials per tenant or caller, as on `main`                        |
| The sandbox                                                                  | Awkward                                 | A sandbox outlives a value; changing it means a new sandbox           |
| `build`, channels, schedules, workflow tools, `defaultTools`, `experimental` | Not candidates                          | Read at build time or before any session exists                       |

`reasoning`, `modelContextWindowTokens`, and `modelOptions` already vary with the model: the
dynamic `model` field returns them together, because they're one decision.

</details>

### 2. `ctx.oncePer` keeps what must survive a restart

**Today.** A dynamic tool's callback usually closes over data its handler fetched:

```ts
// agent/tools/query.ts (today)
export default defineDynamic({
  events: {
    "session.started": async () =>
      Object.fromEntries(
        (await listTables()).map((t) => [
          t.name,
          defineTool({
            description: `Query ${t.name}. Columns: ${t.columns.join(", ")}`,
            inputSchema: z.object({ sql: z.string() }),
            execute: ({ sql }) => runReadOnly(t.name, sql), // captures `t`
          }),
        ]),
      ),
  },
});
```

After a cold start, eve needs `execute` again, but a function can't be saved. So at build time eve
rewrites each callback to take its captured variables as an argument, and at run time saves what
`t` was. That works only for code the compiler understands: callbacks and schemas are written
inline, captures must be JSON, and `execute: makeExecutor()` is rejected. A package that returns
tools from `node_modules`, where the compiler can't see, wraps every callback in
`defineDurableCallback` and every schema in `defineDurableSchema`.

**The change.** The fetch goes in `ctx.oncePer`, and the tools are built from its result with
ordinary code:

```ts
// agent/tools/query.ts (proposed)
export default defineDynamic(async (ctx) => {
  const tables = await ctx.oncePer(ctx.session.id, async () =>
    (await listTables()).map(({ name, columns }) => ({ name, columns })),
  );
  return Object.fromEntries(tables.map((t) => [t.name, tableTool(t)])); // the defineTool above
});
```

`ctx.oncePer(key, fn)` runs `fn` the first time it sees `key`, and keeps the JSON it returns. A
later evaluation with the same key, in any process, gets the kept result without running `fn`. On
a cold start, eve runs the function again: the memo returns the saved tables, and `tableTool`
builds the same tools, callbacks included.

So the rule for authors is: questions to the outside world, such as database queries, a router's
choice, or randomness, go inside a memo. The code around it builds tools and models from the
answers.

**Why it's useful.**

- No compiler pass over authored code. About 2,100 lines of build transforms and callback
  rebinding on `main` go, along with `defineDurableCallback` and `defineDurableSchema`
  ([What this removes](#what-this-removes)).
- Tools are ordinary code. Helpers, factories, schemas in variables, and packages that return
  ordinary tools all work.
- What survives a restart is explicit: memo results, and nothing else. A cold start doesn't query
  the database again to recover its tools.

**The cost.** Code outside a memo must be deterministic: from the same memo results and context, it
must build the same tools. Nothing stops an `await` or a `Math.random()` outside a memo. It runs
on every evaluation and its result isn't kept, so a cold start can quietly build a different tool,
where `main`'s compiler saved every capture automatically. In development, eve evaluates each
definition twice with its memos fixed and compares the results. That catches most of these
mistakes on the first run, not all of them.

<details>
<summary>Memo rules</summary>

- **Keys and results are JSON.** Keys compare as canonical JSON. A key is at most 64 KB and a result
  at most 1 MB; the error names the file and the memo, and suggests keeping an ID and fetching the
  rest when it's used. A non-JSON result names the path and type, such as
  `oncePer returned Date at $.accounts[2].createdAt`. A function that returns nothing keeps `null`.
- **A memo holds one key at a time.** A new key replaces the old one, so a key that comes back later
  runs `fn` again, and alternating between two keys runs it each time. Storage grows with the
  number of memos, not with turns.
- **Most definitions need one memo, and it needs no name.** A definition with more names the others:
  `ctx.oncePer(key, fn, { name: "tables" })`. Two unnamed memos in one evaluation fail with an
  error naming the file. Memos in one evaluation can run concurrently, such as under
  `Promise.all`.
- **Memos belong to their definition.** Two files that memoize the same key each run their own.
  Memos don't nest, and `oncePer` only works while the definition is being evaluated.
- **Memos are private.** They live in the session's checkpointed state, never on the public stream.
- **Types help where they can.** Public types reject statically known non-JSON results, and
  runtime validation covers external data.

</details>

### 3. Lifetimes are keys

**Today.** "Once per session" means `session.started` and "once per turn" means `turn.started`.
There's no built-in way to say "once per tenant". `auto()`, the built-in router that picks a model per
turn, needs "once per turn" on `step.started`, so it builds its own cache with framework internals:

```ts
// packages/eve/src/models/auto.ts (today, condensed)
const selection = new ContextKey<{ turnId: string; model: string }>(
  `eve.experimental.evaluate.model.${fingerprint}`, // hash of options, fallback, evaluator
);

return defineDynamic({
  events: {
    "step.started": async (event, ctx) => {
      const state = loadContext();
      const previous = state.get(selection);
      if (previous?.turnId === turnId(event)) return models.get(previous.model)!; // decided

      const result = await evaluate({ model, state: routingState(ctx), questions: { route } });
      state.set(selection, { turnId: turnId(event), model: result.answers.route.choice });
      return models.get(result.answers.route.choice)!;
    },
  },
});
```

That's a memo written by hand: the turn ID is the key, and the saved option is the result. It saves
an option key rather than a model because a model instance can't be saved, and the fingerprint
makes a deployment with different options decide again. `loadContext` and `ContextKey` aren't
public, so an author's own router can't do the same. It either asks its router before every model
call or reaches into internals.

**The change.** The key is the lifetime:

| Key                                                    | Runs                                        |
| ------------------------------------------------------ | ------------------------------------------- |
| No memo                                                | Before every model call                     |
| `ctx.turn.id`                                          | Once per turn                               |
| `ctx.session.id`                                       | Once per session, until a deployment change |
| Any JSON, such as a tenant ID or `[team, ctx.turn.id]` | Whenever it changes                         |

A router that picks a tier once per turn:

```ts
// agent/agent.ts
const models = { hard: openai("gpt-6-sol"), easy: openai("gpt-6-luna") };

export default defineAgent({
  model: defineDynamic(async (ctx) => {
    const tier = await ctx.oncePer(ctx.turn.id, () => chooseTier(ctx.messages)); // "hard" | "easy"
    return models[tier];
  }),
});
```

`auto()` becomes the same few lines inside eve, with no context key or fingerprint, and its
authoring API doesn't change.

**Why it's useful.**

- Any lifetime, including combinations, without a list of named lifetimes or precedence between
  them.
- `auto()` isn't special, and an author's own router is ordinary code.
- The memo keeps data, so the code after it can return a live provider instance. `main` rejects
  provider instances from session and turn model handlers, because it saves the model itself.

<details>
<summary>How keys behave</summary>

- **Only the key decides.** `fn` can read anything in `ctx`, including the conversation, but those
  reads don't make it run again. The router above reads the conversation as it was at the turn's
  first model call.
- **Fetched data is only as fresh as its key.** A memo keyed by `ctx.turn.id` fetches again each
  turn, not whenever the database changes.
- **A session key latches a first value.** `await ctx.oncePer(ctx.session.id, () => ctx.model.id)`
  keeps the model of the first call that evaluated it, until a deployment change.

</details>

### 4. Hooks can act on state, and return commands

**Today.** A hook is a map of event handlers. That fits "send a notification for every settled
turn", but a condition such as "the session is idle" isn't one event: the hook has to work out
which events can cause it. Cancelling means calling `ctx.cancel()` from the handler, and there's no
way to ask for a compaction.

**The change.** A hook can also be a function that eve runs after every commit. It reads the same
view a client sees, and returns a command:

```ts
// agent/hooks/compact-when-idle.ts
import { idle } from "eve/events";
import { compact, defineHook } from "eve/hooks";

export default defineHook((ctx) => {
  if (ctx.turn === null || !idle(ctx.view)) return null; // nothing to compact before a first turn
  return compact({ reason: "The session went idle." });
});
```

A command acts once on its target, so returning it again while its condition holds is safe:

- **`cancel()` targets the turn running when it's returned.** It's done once eve has asked that turn
  to stop. Between turns, it does nothing.
- **`compact()` targets the next model call,** and is done when that compaction starts.

So the hook above compacts once each time the session goes idle, before the next turn's first
model call. The event form stays, and its handlers return commands too:

```ts
// agent/hooks/require-credentials.ts
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      if (!(await hasWorkspaceCredentials(ctx.session.auth.current))) {
        return cancel("Workspace credentials are unavailable.");
      }
    },
  },
});
```

eve applies the cancel before the turn's dynamic values run or its model is called. A hook
function can use `ctx.oncePer` for its I/O. This one emails once per session, the first time
spending passes $50:

```ts
// agent/hooks/budget-alert.ts
export default defineHook(async (ctx) => {
  if (spentUsd(ctx.view) <= 50) return;
  await ctx.oncePer(ctx.session.id, (occurrence) =>
    email.send({ template: "budget", idempotencyKey: occurrence.id }),
  );
});
```

**Why it's useful.**

- "Whenever the session is idle" and "for every settled turn" are different requests, and each
  gets its own form.
- A hook acts with a plain `if` and a returned command, without tracking whether it already acted.
- Hooks read committed state and event payloads, never the conversation, so they can run after
  every commit, including between turns.

**The cost.** A hook function runs after every commit, so it must be cheap; I/O belongs in a memo.
A condition that stays true after its command acts asks again at the next target: a hook that
compacts above a token count compacts before every model call if compaction can't get below it.

<details>
<summary>Retries and idempotency keys</summary>

Every memo run and every event handler call has an **occurrence**, whose `id` is the same if eve
retries it. Pass it to an external service as an idempotency key; if an occurrence does several
things, give each a stable suffix, such as `${occurrence.id}:email`.

A memo holds one key at a time, so a key and an occurrence are different things. Take a memo keyed
by whether spending is over budget, `ctx.oncePer(spentUsd(ctx.view) > 50, fn)`:

```text
key:         false → true → false → true
occurrence:    1       2       3       4
```

The two `true` keys are equal but are different occurrences: a retry of occurrence 2 keeps its
identity, and occurrence 4 gets a new one. Work that should happen once keeps one key, as the
budget alert does with `ctx.session.id`.

eve derives a memo occurrence's identity from the definition, the memo's name, the number of times
its key has changed, and a digest of the key. A retry after a crash computes the same identity
because nothing new was committed, so eve writes nothing before `fn` runs. An event handler's
occurrence is the fact's position in the stream.

An effect can succeed just before a process fails to save its result. A memo's result becomes
durable with the step that ran it, and a crash before then runs `fn` again with the same
occurrence. **Execution is at least once until checkpointed,** not exactly once, so an external
service must honor the idempotency key to avoid repeating its effect.

</details>

### 5. Unhandled errors fail the turn

**Today.** What happens when a handler throws depends on what it is. A throwing hook is logged, and
the turn continues. A throwing tool, skill, instruction, or subagent resolver is logged and
skipped, so the turn continues without what it would have added. A throwing connection handler
fails the turn.

**The change.** An unhandled error in a dynamic value, a memo, or a hook fails the turn. Behavior
that's optional catches its own errors:

```ts
// agent/tools/crm.ts
export default defineDynamic(async (ctx) => {
  const tenantId = ctx.session.auth.current?.attributes.tenantId;
  if (!tenantId) return null;
  try {
    const rows = await ctx.oncePer(tenantId, () => db.crmTools(tenantId));
    return Object.fromEntries(rows.map((row) => [row.slug, crmTool(row)]));
  } catch {
    return null; // no CRM tools for this model call; the memo runs again before the next one
  }
});
```

Without the `try`, a CRM outage fails the turn. A required check, such as the credentials hook in
[change 4](#4-hooks-can-act-on-state-and-return-commands), doesn't catch, so it can't be skipped.

**Why it's useful.**

- A required instruction or credential check can't silently disappear.
- A failed memo keeps nothing, so the next evaluation tries again, even under the same key. A
  transient error can't break a once-per-session value for the rest of the session.

**The cost.** Hooks that only observe, such as audit or metrics hooks, must catch their own errors
if they shouldn't fail a turn. Where the `try` sits matters too: a memo that catches its own
failure and returns `null` keeps that `null` until its key changes, while a `try` around
`await ctx.oncePer(...)` keeps nothing, so the next evaluation tries again.

<details>
<summary>Errors outside a turn, and event handlers</summary>

- **A hook that fails between turns has no turn to fail.** eve logs the hook, the occurrence, and
  the error, and doesn't retroactively fail a finished turn. A public fact for it can come later:
  readers ignore fact types they don't recognize, so adding one doesn't break them.
- **A dynamic value's error fails the turn before the model call it was evaluated for; a hook's,**
  before the turn's next model call or as the turn would otherwise settle.
- **An event handler runs once per fact.** A failure isn't retried on a later fact, though the
  workflow's own step retries still apply.
- **There's no failure-policy option at first.** eve must not respond to a failure by silently
  dropping a required instruction, or by falling back to a static connection with different
  credentials. An `onError` option can come later if a case needs one.

</details>

### 6. User instructions join the conversation when they change

**Today.** A dynamic instruction with `role: "user"` is added to the conversation, before the
turn's input, every time its handler returns it. A `turn.started` handler that returns the same
brief adds the same text every turn; the docs call this intentional.

**The change.** An instruction's role decides how it behaves:

- A **system instruction** is held. It applies to every model call while its definition returns
  it, and goes away when it returns `null`.
- A **user instruction** joins the conversation, before the turn's input, when its content differs
  from the last one its file added. After that it's history, like any other message.

```ts
// agent/instructions/brief.ts
export default defineDynamic(async (ctx) => {
  const brief = await ctx.oncePer(ctx.turn.id, () => loadBrief(ctx.session.auth.current));
  return brief ? defineInstructions({ content: brief, role: "user" }) : null;
});
```

The brief is fetched every turn, and joins the conversation only when it changed.

**Why it's useful.** A per-turn brief doesn't pile up identical copies, and the rule doesn't
depend on when the function runs. `main`'s recipe that hands a stranded session's transcript to
its replacement keeps working: a memo keyed by the predecessor's ID reads the transcript once,
and it joins once.

**The cost.** This is a behavior change. An agent that relied on the same text being added again
each turn, for example to keep a reminder near the end of a long conversation, has to change the
content to get that.

<details>
<summary>Edge cases</summary>

- A later `null` adds nothing, and doesn't remove what's already in the conversation.
- Compaction and clear treat an added instruction like other history, as on `main`, and neither
  makes the same content join again.
- eve keeps one digest per file, of the last content it added, in the session's private state.
- A hook command for adding messages, such as from an event handler, can come later if a case
  needs one.

</details>

### 7. Remote agents are rebuilt from how they were opened

**Today.** A remote subagent's `auth` and `headers` are needed outside a model call: when the parent
messages, resets, or cancels the child, and in the route that follows the child's stream. On
`main`, a compiler pass finds them in a dynamic remote agent and registers them by ID for those
places.

**The change.** When a step opens a remote child, it saves a private **binding** with the child:
the session's ID and auth, the turn, `ctx.now`, and the memo results the remote agent was built from.
Wherever eve reaches the child later, it runs the definition again with that binding. Each memo
returns its bound result without running, and eve checks that the returned name and URL match
what the child was opened with before it sends any credentials.

```ts
// agent/subagents/finance.ts
export default defineDynamic(async (ctx) => {
  const tenantId = ctx.session.auth.current?.attributes.tenantId;
  if (!tenantId) return null;
  const tenant = await ctx.oncePer(tenantId, () => tenants.lookup(tenantId)); // { id, region }
  return defineRemoteAgent({
    description: "Analyze financial and accounting data.",
    url: `https://${tenant.region}.finance.example.com`,
    auth: async () => ({
      headers: { authorization: `Bearer ${await mintTenantToken(tenant.id)}` },
    }),
  });
});
```

`auth` closes over `tenant`, and the definition can rebuild it anywhere. If Alice's turn opens the
child and Bob, from another tenant, writes to the session later, the parent's requests to that
child still carry Alice's tenant, because the binding holds the session as it was when the child
opened.

**Why it's useful.** The compiler pass for remote agents goes, and credentials are always rebuilt
from the same data the child was opened with, never from whoever is calling now.

**The cost.** Outside a model call there's no conversation. Reading `ctx.view`, `ctx.messages`, or
`ctx.model` there fails the request with an error naming the file and the read. So a gate like this
works before every model call, and fails when eve later messages or cancels the child:

```ts
if (!mentionsInvoices(ctx.messages)) return null; // fails outside a model call
```

The fix is to move the gate into a memo keyed by turn, which decides once per turn rather than
before every model call:

```ts
const offer = await ctx.oncePer(ctx.turn.id, () => mentionsInvoices(ctx.messages), {
  name: "offer",
});
if (!offer) return null;
```

In development, eve runs the definition from each new binding as soon as the child opens, so a read
that can't be restored fails the first time rather than on a later message or cancel. This is the
case where `select`, `record`, and `render` is stronger ([Alternatives](#alternatives)).

<details>
<summary>How the binding is carried</summary>

- **Every path to the child carries it:** the steps that message, reset, and cancel the child, the
  route that follows its stream, and the relay that answers its questions.
- **It stays private.** It rides the parent's step state and a private side stream, never a public
  fact or a request to the child.
- **Restores are strict.** A memo the child wasn't opened with, or a key that differs from the
  bound one, fails the request with an error naming the file.
- **The destination check holds across deployments.** If a new deployment's code returns a
  different name or URL for the same binding, the request fails rather than sending credentials
  elsewhere.
- **A dynamic `defineWorkspaceAgent`,** which `main`'s compiler pass never handled, takes the same
  path, though the prototype doesn't test it yet.

</details>

## When things run

This is the contract authors can rely on, rather than an incidental order of internal callbacks.

- **Hooks run after each commit,** inside a turn or between turns. An event handler runs for each
  matching fact. Streamed progress, such as content deltas, reaches only event handlers that
  subscribe to it.
- **Dynamic values run before each model call.** eve runs each definition, runs the memos whose
  keys are new, and fixes the model, tools, and context that call uses. Changes during a batch of
  tool calls affect the next model call.
- **Hooks run first.** Before a model call, hooks finish with the latest commit before dynamic
  values run, so a hook that cancels stops the turn before any dynamic value fetches data.
- **Only ordinary model calls count:** the first of each turn, the one after a batch of tool calls,
  and the one after an approval resumes. Compaction's summarizing call, the evaluator `auto()` asks,
  and `evaluate` inside a tool don't run dynamic values.
- **A steering message is seen at the next model call.** It isn't a new turn, so memos keyed by
  `ctx.turn.id` don't run again, but code that reads `ctx.messages` sees it.
- **No dynamic value runs while a turn waits** for an approval or an answer. When an approval resumes, the
  approved calls run first, then dynamic values before the next model call.
- **Compaction changes what comes next.** The next model call sees the compacted conversation, so
  code over messages can change its answer: the image model switches back to text once a summary
  replaces the image.
- **A tool call runs only as it was offered.** A call that waits for approval keeps a digest of its
  tool's declaration and of the memo results it was built from. If they differ when the call runs,
  for example because the caller's role or tenant changed during the wait, the call fails with a
  tool error saying the tool changed since it was offered, and the model can request it again.
  Authorization is still checked when the call runs.

Running a definition and installing its result in a model request are separate, which leaves room
to keep a provider's tool list stable where prompt caching benefits from it.

### After a cold start

```text
first evaluation:  function → oncePer runs fn → result kept → capability
                                                    │
                                                    ▼
                                               durable memo
                                                    │
fresh process:     function → oncePer returns ◄─────┘ → capability
```

A fresh process runs each definition again, and each memo returns its committed result. eve
doesn't query a database or ask a router again just to recover a capability. A memo that was
interrupted before its result committed runs again, with the same occurrence.

eve then compares what the fresh evaluation offers with what the session was offered: tool
declarations, and a connection's URL, instance key, and credential owner. A difference means code
outside the memos isn't deterministic. The memos are still valid data, so eve keeps them, offers
the new value from this model call on, and logs a diagnostic naming the file. Calls already
requested from the old version fail, as described above. The comparison is a check, not a proof
that two callbacks behave the same.

### After a deployment change

At the move to a new deployment, which happens only while a session is idle, eve discards the
memos of dynamic values, and each runs again at the next model call. New code shouldn't build from
data it may not understand, and a once-per-session instruction shouldn't keep an outdated policy
just because it's plain text. So a memo keyed by `ctx.session.id` that captured the first caller
captures whoever is current after the change. `main` only re-resolves session tools and subagents
here; its session instructions, skills, models, and connections keep their old results.

Hook memos are kept. A hook doesn't build anything from its memo: the memo records that an effect
happened, like a `defineState` flag on `main`, which also survives a redeploy. Discarding it would
send the budget alert again after every deployment. Event-handler occurrences that already ran
don't run again either. A hook that should act again under new code changes its key, for example
by adding a version. Keeping dynamic-value memos across deployments on purpose can come later if a
case needs it.

### What eve stores

- **Memos, remote-child bindings, and instruction digests are private.** Memos and digests live in
  the session's checkpointed state, and bindings in a private side stream. None reach the public
  stream.
- **Stored state rides along every step.** A turn step's input and result carry the session's
  state, so memos are re-sent and saved again on each step. `main` has the same cost for its
  closure snapshots, which it stores per callback with no cap.
- **Diagnostics go to logs, and later traces.** Each memo run reports the file, the memo, the
  occurrence, why it ran (a new key, a retry, or a deployment change), how long it took, and whether
  the value changed. The prototype logs these at debug level; there's no public API for them.

## Examples from main's docs

The examples from today's dynamic capabilities and hooks guides, rewritten. Most lose their event
name and nothing else.

<details>
<summary>Route image inputs to a vision model</summary>

```ts
// agent/agent.ts (today)
export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const hasImage = ctx.messages.some(
          (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                part.type === "image" ||
                (part.type === "file" &&
                  (part.mediaType === "image" || part.mediaType.startsWith("image/"))),
            ),
        );

        return hasImage ? "google/gemini-3.5-flash" : "zai/glm-5.2";
      },
    },
  }),
});
```

```ts
// agent/agent.ts (proposed)
export default defineAgent({
  model: defineDynamic((ctx) =>
    ctx.messages.some(hasImage) ? "google/gemini-3.5-flash" : "zai/glm-5.2",
  ),
});
```

The function runs before every model call, as a `step.started` handler does.

</details>

<details>
<summary>Choose a model by plan</summary>

```ts
// agent/agent.ts (today)
export default defineAgent({
  model: defineDynamic({
    events: {
      "session.started": (_event, ctx) => {
        if (ctx.session.auth.initiator?.attributes.plan === "enterprise") {
          return "anthropic/claude-opus-5.5";
        }

        return "anthropic/claude-sonnet-5";
      },
    },
  }),
});
```

```ts
// agent/agent.ts (proposed)
export default defineAgent({
  model: defineDynamic((ctx) =>
    ctx.session.auth.initiator?.attributes.plan === "enterprise"
      ? "anthropic/claude-opus-5.5"
      : "anthropic/claude-sonnet-5",
  ),
});
```

The behavior is the same, because the initiator doesn't change. Reading `session.auth.current`
instead follows the current caller.

</details>

<details>
<summary>Expose a subagent to enterprise callers</summary>

```ts
// agent/subagents/finance/agent.ts (today)
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (ctx.session.auth.current?.attributes.plan !== "enterprise") {
        return null;
      }

      return defineAgent({
        description: "Analyze financial and accounting data.",
        model: ctx.model ? ctx.model.id : "openai/gpt-5.5-mini",
      });
    },
  },
});
```

```ts
// agent/subagents/finance/agent.ts (proposed)
export default defineDynamic((ctx) =>
  ctx.session.auth.current?.attributes.plan === "enterprise"
    ? defineAgent({ description: "Analyze financial and accounting data.", model: ctx.model.id })
    : null,
);
```

The behavior differs: today the subagent keeps the parent's model from when the session started,
and here it follows the parent's model. Keeping the first one is a memo:
`model: await ctx.oncePer(ctx.session.id, () => ctx.model.id)`. A remote subagent has the same
shape, returning `defineRemoteAgent({ description, url })`
([change 7](#7-remote-agents-are-rebuilt-from-how-they-were-opened)).

</details>

<details>
<summary>One connection per account</summary>

```ts
// agent/connections/accounts.ts (today)
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const principal = ctx.session.auth.current;
      if (principal?.principalType !== "user") return null;

      const accounts = await listEnabledAccounts(principal);
      return Object.fromEntries(
        accounts.map((account) => [
          account.slug,
          defineMcpClientConnection({
            url: "https://mcp.cloud.example.com",
            description: `${account.label} (${account.accountId})`,
            instanceKey: account.accountId,
            auth: {
              credentialOwner: "user",
              getToken: ({ principal }) => mintAccountToken(principal, account),
            },
          }),
        ]),
      );
    },
  },
});
```

```ts
// agent/connections/accounts.ts (proposed)
export default defineDynamic(async (ctx) => {
  const principal = ctx.session.auth.current;
  if (principal?.principalType !== "user") return null;

  const accounts = await ctx.oncePer(principal, () => listEnabledAccounts(principal));
  return Object.fromEntries(
    accounts.map((account) => [
      account.slug,
      defineMcpClientConnection({
        url: "https://mcp.cloud.example.com",
        description: `${account.label} (${account.accountId})`,
        instanceKey: account.accountId,
        auth: {
          credentialOwner: "user",
          getToken: ({ principal }) => mintAccountToken(principal, account),
        },
      }),
    ]),
  );
});
```

One line changes: the fetch is a memo, keyed by the caller. Today's guide warns that connection
handlers "may run again when a parked turn resumes or a durable step retries"; here
`listEnabledAccounts` runs once per caller. The token is minted by `getToken` when it's needed,
and never kept.

</details>

<details>
<summary>One tool per warehouse table</summary>

This is [change 2](#2-ctxonceper-keeps-what-must-survive-a-restart), with the tool built inline:

```ts
// agent/tools/query.ts (proposed)
export default defineDynamic(async (ctx) => {
  const tables = await ctx.oncePer(ctx.session.id, async () =>
    (await listTables()).map(({ name, columns }) => ({ name, columns })),
  );
  return Object.fromEntries(
    tables.map((t) => [
      t.name,
      defineTool({
        description: `Query ${t.name}. Columns: ${t.columns.join(", ")}`,
        inputSchema: z.object({ sql: z.string() }),
        execute: ({ sql }) => runReadOnly(t.name, sql),
      }),
    ]),
  );
});
```

The memo keeps only the fields the tools use. Today, `main` saves what `execute` captures from its
handler. Here only the memo's result is kept: a value `execute` captures from outside the memo,
such as one fetched with an `await` outside it, is fetched again after a cold start.

</details>

<details>
<summary>Replace session tools each turn</summary>

```ts
// agent/tools/catalog.ts (today)
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => ({ query: queryTool }),
    // On each turn, re-resolve. Replaces this file's session.started tools for later calls.
    "turn.started": async (_event, ctx) => ({ search: searchTool }),
  },
});
```

```ts
// agent/tools/catalog.ts (proposed)
export default defineDynamic((ctx) =>
  ctx.view.session.turnCount === 1 ? { query: queryTool } : { search: searchTool },
);
```

The tools are what the function returns: `query` for the first turn, and `search` after it. Today,
what a model call sees depends on how scopes combine: session, turn, and step tools are merged, a
narrower scope wins a name collision, and steering skips `turn.started`.

</details>

<details>
<summary>A package's tool</summary>

```ts
// provider-package/search.ts (today)
export function createSearchTool(baseUrl: string) {
  return defineTool({
    description: "Search the provider catalog.",
    inputSchema: z.object({ query: z.string() }),
    execute: defineDurableCallback({
      closure: { baseUrl },
      callback: async ({ baseUrl }, { query }: { query: string }) => {
        const response = await fetch(`${baseUrl}/search?q=${encodeURIComponent(query)}`);
        return response.json();
      },
    }),
  });
}
```

```ts
// provider-package/search.ts (proposed)
export function createSearchTool(baseUrl: string) {
  return defineTool({
    description: "Search the provider catalog.",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      const response = await fetch(`${baseUrl}/search?q=${encodeURIComponent(query)}`);
      return response.json();
    },
  });
}

// agent/tools/search.ts
export default defineDynamic((ctx) => {
  const region = ctx.session.auth.current?.attributes.region ?? "us";
  return { search: createSearchTool(`https://${region}.catalog.example.com`) };
});
```

`defineDurableCallback` and `defineDurableSchema` go, along with the rule that every callback
property, including labels, approval policies, `approvalKey`, and `toModelOutput`, be wrapped. An
extension doesn't need `eve extension build` for its tools to survive a cold start.

</details>

<details>
<summary>Instructions for the caller's plan</summary>

```ts
// agent/instructions/persona.ts (today)
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const plan = ctx.session.auth.current?.attributes.plan ?? "free";
      return defineInstructions({
        content: `The caller is on the ${plan} plan. Match the depth of your answers to it.`,
      });
    },
  },
});
```

```ts
// agent/instructions/persona.ts (proposed)
export default defineDynamic((ctx) => {
  const plan = ctx.session.auth.current?.attributes.plan ?? "free";
  return defineInstructions({
    content: `The caller is on the ${plan} plan. Match the depth of your answers to it.`,
  });
});
```

A system instruction is held, so it follows the plan if a later caller's differs.

</details>

<details>
<summary>A brief for every turn</summary>

```ts
// agent/instructions/brief.ts (today)
export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const brief = await loadBrief(ctx.session.auth.current);
      return brief ? defineInstructions({ content: brief, role: "user" }) : null;
    },
  },
});
```

The proposed version is in [change 6](#6-user-instructions-join-the-conversation-when-they-change).
It also removes today's instruction-specific message snapshots: an instruction resolver sees
static user instructions at `session.started` and session results at `turn.started`, while other
kinds see a different snapshot. Here `ctx.messages` is the same conversation for every dynamic
value before a given model call.

</details>

<details>
<summary>Cancel a turn when credentials are missing</summary>

```ts
// agent/hooks/require-credentials.ts (today)
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      try {
        await loadWorkspaceCredentials(ctx.session.auth.current);
      } catch (error) {
        console.warn("cancelling turn: workspace credentials unavailable", {
          error,
          sessionId: ctx.session.id,
        });
        ctx.cancel();
      }
    },
  },
});
```

```ts
// agent/hooks/require-credentials.ts (proposed)
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      try {
        await loadWorkspaceCredentials(ctx.session.auth.current);
      } catch {
        return cancel("Workspace credentials are unavailable.");
      }
    },
  },
});
```

Cancelling becomes a return value with a reason. Today `ctx.cancel()` has to be called before the
handler's promise settles, and is ignored from work the handler doesn't await. Without the `try`,
the turn fails rather than continuing without the check.

</details>

<details>
<summary>Hooks that observe</summary>

Audit, persistence, and sandbox-stopping hooks stay event handlers with side effects. They read
event payloads and committed session state; a hook that read the assembled conversation moves to
those inputs. A side effect that must happen once per fact keys on `ctx.occurrence.id` instead of
coordinates copied from `event.data`.

</details>

## Alternatives

Four examples cover what differs between the designs: tools built from fetched data, a decision
per turn, a remote agent whose credentials are needed outside a model call, and a hook that acts
when state crosses a line.

- **`oncePer`**, proposed here.
- **`select`, `record`, and `render`**, as #4616 prototypes it. `select` is a synchronous function
  returning the JSON the value depends on, with `once`, `perTurn`, and `perStep` helpers. `record`
  runs when the selection changes, and its JSON result is kept. `render` is synchronous and pure,
  and builds the value from the record. Hooks use `select` with `run`.
- **Moments:** named points at which eve asks a definition for something, such as `beforeSession`,
  `beforeTurn`, and `beforeModelCall`, each with a typed input. A moment's result is kept for its
  lifetime, and `beforeModelCall` builds the value from it. Hooks use moments such as
  `afterCommit`.
- **Code by name**, shown only where it differs: the definition returns data, and a fresh process
  finds the code through a factory registered under a stable name.

The moments and code-by-name APIs are sketches for comparison; neither exists.

<details>
<summary>Tools from a warehouse</summary>

```ts
// oncePer
export default defineDynamic(async (ctx) => {
  const tables = await ctx.oncePer(ctx.session.id, async () =>
    (await listTables()).map(({ name, columns }) => ({ name, columns })),
  );
  return Object.fromEntries(tables.map((t) => [t.name, tableTool(t)]));
});
```

```ts
// select, record, and render
export default defineDynamic({
  select: once,
  record: async () => (await listTables()).map(({ name, columns }) => ({ name, columns })),
  render: (tables) => Object.fromEntries(tables.map((t) => [t.name, tableTool(t)])),
});
```

```ts
// moments
export default defineDynamic({
  beforeSession: async () => (await listTables()).map(({ name, columns }) => ({ name, columns })),
  beforeModelCall: (tables) => Object.fromEntries(tables.map((t) => [t.name, tableTool(t)])),
});
```

```ts
// code by name
const tableTool = defineToolFactory("warehouse.table", (t: Table) =>
  defineTool({
    description: `Query ${t.name}. Columns: ${t.columns.join(", ")}`,
    inputSchema: z.object({ sql: z.string() }),
    execute: ({ sql }) => runReadOnly(t.name, sql),
  }),
);

export default defineDynamic({
  per: "session",
  resolve: async () =>
    (await listTables()).map(({ name, columns }) => tableTool({ name, columns })),
});
```

- **`oncePer` and `select`/`record`/`render` keep the same data** and build the same tools. The
  three callbacks separate them structurally: `render` can't `await`, so it can't fetch by
  accident. With `oncePer`, that separation is a convention.
- **Moments name the lifetime** instead of keying it, and need a fixed list of them.
- **Code by name stores `["warehouse.table", t]` for each tool,** and a fresh process calls the
  registered factory. Recovery is exact, but every factory needs a stable name and registration: a
  parallel API, like `defineDurableCallback`, for every package that ships tools.

</details>

<details>
<summary>A router per turn</summary>

```ts
// oncePer
model: defineDynamic(async (ctx) => {
  const tier = await ctx.oncePer(ctx.turn.id, (occurrence) =>
    chooseTier({ messages: ctx.messages, idempotencyKey: occurrence.id }),
  );
  return models[tier];
}),
```

```ts
// select, record, and render
model: defineDynamic({
  select: perTurn,
  record: async (_turn, ctx) =>
    await chooseTier({ messages: await ctx.messages(), idempotencyKey: ctx.occurrence.id }),
  render: (tier) => models[tier],
}),
```

```ts
// moments
model: defineDynamic({
  beforeTurn: async (ctx) =>
    await chooseTier({ messages: ctx.messages, idempotencyKey: ctx.occurrence.id }),
  beforeModelCall: (tier) => models[tier],
}),
```

All three keep the tier and build the model from it. They differ only in how the lifetime is
spelled: a key, a selector helper, or a moment's name.

</details>

<details>
<summary>A remote agent per tenant</summary>

```ts
// oncePer
export default defineDynamic(async (ctx) => {
  const tenantId = ctx.session.auth.current?.attributes.tenantId;
  if (!tenantId) return null;
  const tenant = await ctx.oncePer(tenantId, () => tenants.lookup(tenantId));
  return financeAgent(tenant);
});
```

```ts
// select, record, and render
export default defineDynamic({
  select: ({ session }) => session.auth.current?.attributes.tenantId ?? null,
  record: async (tenantId) => (tenantId === null ? null : await tenants.lookup(tenantId)),
  render: (tenant) => (tenant === null ? null : financeAgent(tenant)),
});
```

```ts
// moments
export default defineDynamic({
  beforeTurn: async (ctx) => {
    const tenantId = ctx.session.auth.current?.attributes.tenantId;
    // Every turn: there's no moment for "the tenant changed".
    return tenantId ? await tenants.lookup(tenantId) : null;
  },
  beforeModelCall: (tenant) => (tenant === null ? null : financeAgent(tenant)),
});
```

`financeAgent(tenant)` returns `defineRemoteAgent({ description, url, auth })`, with `auth`
closing over `tenant`.

- **`select`/`record`/`render` is the strongest here.** Outside a model call, eve calls
  `render(record)`, which needs no context at all, so a gate on the conversation in `select` costs
  nothing. With `oncePer`, eve runs the whole function from the child's binding, and a read of the
  conversation outside a memo fails there.
- **Moments can't say "when the tenant changes".** `beforeSession` misses a new caller, and
  `beforeTurn` looks the tenant up every turn.

</details>

<details>
<summary>A budget alert</summary>

```ts
// oncePer
export default defineHook(async (ctx) => {
  if (spentUsd(ctx.view) <= 50) return;
  await ctx.oncePer(ctx.session.id, (occurrence) =>
    email.send({ template: "budget", idempotencyKey: occurrence.id }),
  );
});
```

```ts
// select, record, and render
export default defineHook({
  select: ({ view }) => spentUsd(view) > 50,
  run: async (over, ctx) => {
    if (over) await email.send({ template: "budget", idempotencyKey: ctx.occurrence.id });
  },
});
```

```ts
// moments
const alerted = defineState("budget-alert.sent", () => false);

export default defineHook({
  afterCommit: async (ctx) => {
    if (spentUsd(ctx.view) <= 50 || alerted.get()) return;
    await email.send({ template: "budget", idempotencyKey: `${ctx.session.id}:budget` });
    alerted.update(() => true);
  },
});
```

- **`select` and `run` act on each change** of the selection; `oncePer` does the same by keying
  on the condition, or acts once per session, as here, by keying on the session.
- **Moments have no memory of their own.** The hook keeps its own flag in state and builds its own
  idempotency key.

</details>

### Other approaches

- **Events, as on `main`.** Handlers on lifecycle events, with a compiler that saves what callbacks
  capture. Each kind keeps its own rules, and recovery runs handlers again.
- **`select`, `record`, and `render`.** Separates data from code structurally: `select` and
  `render` can't `await`. Stronger for values used outside a model call, and it's what #4616
  prototypes. But three callbacks for one idea read worse in the common cases, which need no data
  and fit in one function.
- **Moments.** Honest about when eve asks, unlike today's handlers, some of which receive stand-in
  events that were never published. But a fixed list of lifetimes brings back precedence between
  them. Decision moments, such as before tool calls, before compaction, or before a turn settles,
  could come later where a concrete case needs a typed decision.
- **Code by name.** Data with factories found by registered name, the way `pi-durable` resolves
  code. Exact recovery, at the cost of naming and registering every factory.
- **Compiler closure conversion,** as on `main`. Automatic, and it saves every capture, but it
  restricts what callbacks may look like and costs a compiler. A lint for `await` outside a memo
  would recover some of its safety without one.
- **A synchronous function with suspending memos,** like React's `use`: a memo without a result
  suspends the function, and eve runs it again when the result arrives. That makes `await` outside
  a memo impossible, but evaluation is harder to follow and every new memo re-runs the function.
- **Decisions as public facts.** Recording a router's choice or a tenant lookup on the stream would
  show it to clients, but exposes private data and grows the public schema. Memos stay private; a
  specific decision can become a fact when a client needs it, as the chosen model already appears
  in `model.started`.

## What this removes

On `main`, recovering dynamic tools and remote credentials takes a compiler. About 1,060 lines of
build transforms under `internal/workflow-bundle/dynamic-*` parse authored source, find what
callbacks capture, and rewrite them into registered factories. About 1,020 more, in
`tools/durable-callbacks.ts` and `context/dynamic-tool-lifecycle.ts`, register and rebind them at
run time, alongside `defineDurableCallback` and `defineDurableSchema` for code the compiler can't
see. Memos need none of it, and builds stop parsing authored source.

The rest follows from having one lifecycle:

- **Six lifecycles do one job six times.** Each decides when to run, where to keep its result, how
  a later result replaces an earlier one, and how to recover after a restart, with its own rules.
  That's what authors learn per kind, and what the code repeats. One runner does it once; a kind
  only supplies how its value joins the session.
- **Precedence and replay rules disappear.** Turn results shadowing session results, steering
  skipping `turn.started`, and re-running handlers to rebind callbacks are cases one function per
  value doesn't have, and neither do their tests.

## Scope

The first change is dynamic values and hooks on the v27 view, with `ctx.oncePer`, retry identities,
commands, and recovery. It keeps `defineDynamic` and event hooks, and adds hook functions and
returned commands. Moving #4616 to this API changes its definitions and hook kind: the runner keeps
one result per memo rather than one record per definition, and remote credentials come from
running the definition with the child's binding rather than calling `render`.

Not included: `defineGuard`, a universal public `defineReaction`, an `onError` option, a lint for
`await` outside memos, dependency graphs between definitions, a command for adding messages, or a
new task-authoring API. An `onError` option and the lint may come later.
