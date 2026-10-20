---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-19"
---

# Dynamic values and hooks as functions

An eve agent can change during a session. Its model, tools, skills, instructions, connections, and
subagents can depend on who is calling and what the conversation says, and hooks run code as the
session progresses.

Today a dynamic value is a set of handlers on lifecycle events, which has a few drawbacks:

- **Each kind has its own rules.** Models and tools can update before every model call; skills,
  instructions, connections, and subagents only when a session or turn starts. Which result wins
  when several events fire, what a steering message changes, and what happens when a handler
  throws all differ by kind.
- **Surviving a restart requires a compiler.** A session can continue in another process, and a
  dynamic tool's callback has to be rebuilt there. eve rewrites authored callbacks at build time to
  save what they capture, so authors have to write callbacks in shapes the compiler understands.
- **Hooks can watch, but can't really act.** Cancelling the turn is the only command a hook has. A
  hook that throws is logged and the turn continues, so it can't enforce a check.

Example from `main`, providing a different tool set for each tenant:

```ts
// agent/tools/crm.ts (today)
export default defineDynamic({
  events: {
    // `session.started` would keep the first caller's tenant, so this queries again every turn.
    "turn.started": async (_event, ctx) => {
      const tenantId = ctx.session.auth.current?.attributes.tenantId;
      if (!tenantId) return null;
      const rows = await db.crmTools(tenantId);
      // eve's compiler rewrites crmTool's callbacks to save the `row` each one captures.
      return Object.fromEntries(rows.map((row) => [row.slug, crmTool(row)]));
    },
  },
});
```

The code has to pick an event, it can't say "once per tenant", and its callbacks survive a restart only
because a build step rewrote them.

The plan replaces the handlers with one function, and adds `ctx.memo` for storing what the function learns
from the outside world:

```ts
// agent/tools/crm.ts (proposed)
export default defineDynamic(async (ctx) => {
  const tenantId = ctx.session.auth.current?.attributes.tenantId;
  if (!tenantId) return null;
  const rows = await ctx.memo(tenantId, () => db.crmTools(tenantId)); // once per tenant
  return Object.fromEntries(rows.map((row) => [row.slug, crmTool(row)]));
});
```

eve keeps the db rows, as they're JSON-serializable. After a restart, the function runs again,
`ctx.memo` returns the saved rows without querying the database, and `crmTool` builds the same
tools with ordinary code.

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

**The change.** A dynamic value is a function of the session:

```ts
// agent/skills/team_playbook.ts (proposed)
export default defineDynamic((ctx) => {
  const team = ctx.session.auth.current?.attributes.team;
  return team && PLAYBOOKS[team] ? defineSkill({ markdown: PLAYBOOKS[team] }) : null;
});
```

eve calls the function in each step that needs the value, against the session as of its latest
commit. Today that's before every model call. The function reads the session through `ctx` and
returns the value, or `null` for none. eve compares the result with what's installed and rebuilds
only what changed.

Don't rely on when or how often eve calls the function. Rely on the result: every model call uses
values computed from the session as of its latest commit.

**Why it's useful.**

- One rule for every kind: no event names, no table of which kind supports which, and no
  precedence between events.
- A value follows whatever its function reads, including the current caller, a steering message,
  and a completed sign-in.
- A model can depend on the conversation, the same way a tool can:

  ```ts
  model: defineDynamic(async (ctx) =>
    (await ctx.messages()).some(hasImage) ? "google/gemini-3.5-flash" : "zai/glm-5.2",
  ),
  ```

**The cost.** The function runs often. Reading `ctx` is cheap, but comparing the result costs in
proportion to its size: a file that returns 200 tools digests 200 declarations each time. Work that
doesn't need to repeat goes in a memo ([change 2](#2-ctxmemo-keeps-what-eve-learns-from-outside)).

<details>
<summary>What the function can read</summary>

| Context       | Fields                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Dynamic value | `ctx.session`, `ctx.channel`, `ctx.view`, `ctx.turn`, `ctx.now`, `ctx.model`, `ctx.messages()`, `ctx.memo`                  |
| Hook handler  | The event, plus `ctx.session`, `ctx.channel`, `ctx.view`, `ctx.turn`, `ctx.now`, `ctx.occurrence`, `ctx.memo`, `ctx.cancel` |
| Memo          | `fn(occurrence)` gets `occurrence.idempotencyKey` and `occurrence.abortSignal`, and can read the enclosing `ctx`            |

- **`ctx.view` is the same view a client folds from the stream,** so selectors from `eve/events`,
  such as `idle(view)`, give the same answer on both sides.
- **`ctx.turn` is the session's latest turn,** running or not, as `{ id, input, status }`. It's
  `null` before the first turn.
- **`ctx.messages()` is the conversation history as of the commit.** It's a function because eve
  assembles it only when something reads it.
- **`ctx.model` is the model chosen for the session,** in every dynamic value except the `model`
  field itself.
- **`ctx.now` is the time of the latest commit,** so it reads the same in every process. Code that
  needs the time uses it rather than `Date.now()`.
- **Hooks don't see the conversation.** An event payload can still carry message content, such as
  a `content.completed` fact's text.

The folder or field decides what a function may return: a tools file returns tools, a skills file
a skill, and the `model` field a model with its settings. `null` or `undefined` contributes
nothing.

</details>

<details>
<summary>Static parts of a dynamic value</summary>

A capability that only sometimes exists doesn't need to be built inside the function. Define it at
module scope and decide in the function whether to return it:

```ts
// agent/tools/refund.ts
const refund = defineTool({
  description: "Refund an order.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => payments.refund(orderId),
});

export default defineDynamic((ctx) =>
  ctx.session.auth.current?.attributes.role === "support" ? refund : null,
);
```

`reasoning`, `modelContextWindowTokens`, and `modelOptions` already vary with the model: the dynamic
`model` field returns them together, because they're one decision.

</details>

### 2. `ctx.memo` keeps what eve learns from outside

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

**The change.** The fetch goes in `ctx.memo`, and the tools are built from its result with ordinary
code:

```ts
// agent/tools/query.ts (proposed)
export default defineDynamic(async (ctx) => {
  const tables = await ctx.memo(ctx.session.id, async () =>
    (await listTables()).map(({ name, columns }) => ({ name, columns })),
  );
  return Object.fromEntries(tables.map((t) => [t.name, tableTool(t)])); // the defineTool above
});
```

`ctx.memo(key, fn)` runs `fn` the first time it sees `key`, and keeps the JSON it returns. A later
call with the same key, in any process, gets the kept result without running `fn`. On a cold
start, eve runs the function again: the memo returns the saved tables, and `tableTool` builds the
same tools, callbacks included.

The rule for authors: code outside a memo runs again at every evaluation, and only memo results are
kept. A question to the outside world, such as a database query or a router's choice, goes inside a
memo when its answer should hold for the key's lifetime. Left outside, it's asked again each time,
and the value follows whatever it answers.

**Why it's useful.**

- No compiler pass over authored code. About 2,100 lines of build transforms and callback
  rebinding on `main` go, along with `defineDurableCallback` and `defineDurableSchema`
  ([What this removes](#what-this-removes)).
- Tools are ordinary code. Helpers, factories, schemas in variables, and packages that return
  ordinary tools all work.
- What survives a restart is explicit: memo results, and nothing else. A cold start doesn't query
  the database again to recover its tools.

**The cost.** Nothing marks what should have been a memo. A query left outside one isn't an error:
it runs before every model call, it can fail the turn at any of them, and a cold start rebuilds
from a fresh answer rather than the one the session had, where `main`'s compiler saved every
capture automatically. Randomness outside a memo is the one real bug. A `Math.random()` or
`Date.now()` in a tool's name or description gives a different value at every evaluation, so the
tool is rebuilt before every call and never matches what was offered. eve reports either one when
it changes what's offered: after a cold start it compares what the function offers with what the
session was offered ([After a cold start](#after-a-cold-start)), and in development it evaluates
each definition twice with its memos fixed and reports any difference.

<details>
<summary>Memo rules</summary>

- **Keys and results are JSON.** Keys compare as canonical JSON, and `undefined` reads as `null`. A
  key is at most 64 KB and a result at most 1 MB; the error names the file and the key's digest, and
  suggests keeping an ID and fetching the rest when it's used. A non-JSON result names the path and
  type, such as `memo returned Date at $.accounts[2].createdAt`.
- **Memos belong to their definition.** A memo's identity is its session, its definition (from the
  file path), and its key. Two files that memoize the same key each run their own.
- **The key tells memos apart.** A definition with more than one memo gives each a distinct key,
  usually a tuple: `ctx.memo(["tables", ctx.session.id], …)` and
  `ctx.memo(["flags", ctx.turn?.id ?? null], …)`. The same key twice in one evaluation fails with
  an error naming the file. When you add a second memo to a definition, give the new one a tuple
  key and leave the original as it is, so its records keep their identity.
- **eve keeps the keys the latest evaluation used.** A key the latest evaluation didn't use is
  dropped, so a key that comes back later runs `fn` again. A loop that memoizes one key per account
  keeps every account's result. A memo behind a branch that the latest evaluation didn't take is
  dropped too, and runs again when the branch comes back.
- **Memos are a cache.** eve may run `fn` again: it discards memos when the session moves to a new
  deployment, and a failed `fn` keeps nothing.
- **Memos are private.** They live in the session's checkpointed state, never on the public stream.
- **Memos run concurrently** under `Promise.all`, and don't nest.

</details>

### 3. Lifetimes are keys

**Today.** "Once per session" means `session.started` and "once per turn" means `turn.started`.
There's no built-in way to say "once per tenant". `auto()`, the built-in router that picks a model
per turn, needs "once per turn" on `step.started`, so it builds its own cache with framework
internals: a `ContextKey` holding the turn ID and the chosen option, and a fingerprint of its
options so that a deployment with different options decides again. `loadContext` and `ContextKey`
aren't public, so an author's own router can't do the same.

**The change.** The key is the lifetime:

| Key                                                    | Runs                                        |
| ------------------------------------------------------ | ------------------------------------------- |
| No memo                                                | Every evaluation                            |
| `ctx.turn.id`                                          | Once per turn                               |
| `ctx.session.id`                                       | Once per session, until a deployment change |
| Any JSON, such as a tenant ID or `[team, ctx.turn.id]` | Whenever it changes                         |

A router that picks a tier once per turn:

```ts
// agent/agent.ts
const models = { hard: openai("gpt-6-sol"), easy: openai("gpt-6-luna") };

export default defineAgent({
  model: defineDynamic(async (ctx) => {
    // "hard" | "easy", decided once per turn
    const tier = await ctx.memo(ctx.turn?.id ?? null, async () => chooseTier(await ctx.messages()));
    return models[tier];
  }),
});
```

The key is the lifetime, not a list of dependencies. `fn` can read anything in `ctx`, but only a
new key runs it again, so this router reads the conversation and still decides once per turn.

**Why it's useful.**

- Any lifetime, including combinations, without a list of named lifetimes or precedence between
  them.
- `auto()` becomes the same few lines inside eve, and an author's own router is ordinary code.
- The memo keeps data, so the code after it can return a live provider instance. `main` rejects
  provider instances from session and turn model handlers, because it saves the model itself.

<details>
<summary>How keys behave</summary>

- **Fetched data is only as fresh as its key.** A memo keyed by `ctx.turn.id` fetches again each
  turn, not whenever the database changes.
- **A session key latches a first value.** `await ctx.memo(ctx.session.id, () => ctx.model.id)`
  keeps the model of the first evaluation that ran it, until a deployment change.
- **Event positions are keys too.** Keying on `ctx.turn.id` is "once per `turn.started`". The
  event-keyed model of today is a special case of this one
  ([Alternatives](#event-keyed-resolution)).

</details>

### 4. Hooks read the view and can cancel

**Today.** A hook is a map of event handlers. It can cancel the turn, but a thrown error is logged
and the turn continues. A required check can therefore silently fail.

**The change.** A hook stays a map of event handlers, one call per matching fact. A handler reads
the same view a client sees, can keep observations with `ctx.memo`, and can call
`ctx.cancel(reason)` to stop the running turn. An unhandled error fails the turn:

```ts
// agent/hooks/require-credentials.ts
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      if (!(await hasWorkspaceCredentials(ctx.session.auth.current))) {
        ctx.cancel("Workspace credentials are unavailable.");
      }
    },
  },
});
```

eve applies the cancel before the turn's dynamic values run or its model is called.

Cancellation acts once on the running turn, so asking again is safe. Between turns it does
nothing; it never cancels a later turn.

A handler on `"*"` runs for every fact except streamed progress. It's the way to act on a
condition over the view, such as `idle(ctx.view)`, when no one event causes it.

**Why it's useful.**

- Required checks can stop a turn rather than silently disappearing.
- Hooks and clients use the same selectors over the same committed view.
- The split between the two kinds stays simple. A dynamic value is a function of the session,
  because a value has to exist at every model call. A hook reacts to facts, because it acts when
  something happens, and it only lists the events it cares about.

**The cost.** Handlers run before the next model call, as on `main`, so a handler's I/O delays it.
Reads that repeat go in `ctx.memo`. External effects still need service-side idempotency and,
for effects such as one alert per session, durable author-managed state. Memos are a cache, not an
effect ledger. A condition that several events can cause either lists them all or uses `"*"`,
which runs once per fact.

<details>
<summary>Retries and idempotency keys</summary>

Every memo run and event handler call has an **occurrence**, whose
`idempotencyKey` is the same if eve retries it. Pass it to an external service; if an occurrence
does several things, give each a stable suffix, such as `${idempotencyKey}:email`.

An external effect can succeed just before a process fails to save the step. A retry can run the
handler again, so the service must honor the key to avoid repeating that effect.

An event handler's occurrence identifies the fact's position in the stream. A cancellation called
after its handler has settled, such as from work the hook didn't await, throws instead of being
dropped.

</details>

### 5. Unhandled errors fail the turn

**Today.** What happens when a handler throws depends on what it is. A throwing hook is logged, and
the turn continues. A throwing tool, skill, instruction, or subagent resolver is logged and
skipped, so the turn continues without what it would have added. A throwing connection handler
fails the turn.

**The change.** An unhandled error in a dynamic value, a memo, or a hook fails the turn.
Behavior that's optional catches its own errors:

```ts
// agent/tools/crm.ts
export default defineDynamic(async (ctx) => {
  const tenantId = ctx.session.auth.current?.attributes.tenantId;
  if (!tenantId) return null;
  try {
    const rows = await ctx.memo(tenantId, () => db.crmTools(tenantId));
    return Object.fromEntries(rows.map((row) => [row.slug, crmTool(row)]));
  } catch {
    return null; // no CRM tools for this model call; the memo runs again at the next evaluation
  }
});
```

Without the `try`, a CRM outage fails the turn. A required check, such as the credentials hook in
[change 4](#4-hooks-read-the-view-and-can-cancel), doesn't catch, so it can't be skipped.

**Why it's useful.**

- A required instruction or credential check can't silently disappear.
- A failed memo keeps nothing, so the next evaluation tries again, even under the same key.
  A transient error can't break a once-per-session value for the rest of the session.

**The cost.** Hooks that only observe, such as audit or metrics hooks, must catch their own errors
if they shouldn't fail a turn. Where the `try` sits matters too: a memo whose `fn` catches its own
failure and returns `null` keeps that `null` until its key changes, while a `try` around
`await ctx.memo(...)` keeps nothing, so the next evaluation tries again.

<details>
<summary>Errors outside a turn</summary>

- **A hook that fails between turns has no turn to fail.** eve logs the hook, the occurrence, and
  the error, and doesn't retroactively fail a finished turn. A handler isn't retried on a later
  fact. A public fact for these failures can come later: readers ignore fact types they don't
  recognize.
- **A dynamic value's error fails the turn before the model call it was evaluated for; a hook's,**
  before the turn's next model call or as the turn would otherwise settle.
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
- A **user instruction** joins the conversation when its content differs from the last one its file
  added. After that it's history, like any other message.

```ts
// agent/instructions/brief.ts
export default defineDynamic(async (ctx) => {
  if (!ctx.turn) return null;
  const brief = await ctx.memo(ctx.turn.id, () => loadBrief(ctx.session.auth.current));
  return brief ? defineInstructions({ content: brief, role: "user" }) : null;
});
```

The brief is fetched every turn, and joins the conversation only when it changed.

**Why it's useful.** A per-turn brief doesn't pile up identical copies, and the rule doesn't depend
on how often the function runs. `main`'s recipe that hands a stranded session's transcript to its
replacement keeps working: a memo keyed by the predecessor's ID reads the transcript once, and it
joins once.

**The cost.** This is a behavior change. An agent that relied on the same text being added again
each turn, for example to keep a reminder near the end of a long conversation, has to change the
content to get that.

<details>
<summary>Edge cases</summary>

- Joining happens only at a model call. An evaluation elsewhere never adds to the conversation.
- New content before a turn's first model call joins just before the turn's input. Content that
  changes later in the turn, after a batch of tool calls, joins at the end of the conversation, so
  it doesn't rewrite what earlier model calls saw.
- A `null` adds nothing and doesn't remove what's already in the conversation, but it does reset
  the saved content: a brief that goes away and comes back joins again.
- Compaction and clear treat an added instruction like other history, and neither makes the same
  content join again.
- eve keeps one digest per file, of the last content it added, in the session's private state. A
  deployment change keeps it, so new code doesn't add the same brief again.

</details>

### 7. Remote agents are restored from their binding

**Today.** A remote subagent's `auth` and `headers` are needed outside a model call: when the parent
messages, resets, or cancels the child, and in the route that follows the child's stream. On
`main`, `auth` takes no arguments and can't close over the handler's `ctx` or locals; the build
fails if it does. So a dynamic remote agent can pick a URL per tenant, but not a credential.

**The change.** When a step opens a remote child, eve saves a private **binding** with the child:
the session's ID and auth, the channel, `ctx.now`, the stream position, and the memo results the
remote agent was built from. Wherever eve reaches the child later, it runs the definition again
from that binding:

- **Memos return their bound results** without running.
- **`ctx.view` and `ctx.turn` are folded from the public stream up to the binding's position,** so
  they read as they did when the child opened.
- **`ctx.messages()` is unavailable.** The conversation is private, and compaction rewrites it, so
  the conversation as it was at that position no longer exists.

eve then checks that the returned name and URL match what the child was opened with before it sends
any credentials.

```ts
// agent/subagents/finance.ts
export default defineDynamic(async (ctx) => {
  const tenantId = ctx.session.auth.current?.attributes.tenantId;
  if (!tenantId) return null;
  const tenant = await ctx.memo(tenantId, () => tenants.lookup(tenantId)); // { id, region }
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

**Why it's useful.** Per-tenant credentials become possible, the compiler pass for remote agents
goes, and credentials are always rebuilt from the data the child was opened with, never from
whoever is calling now.

**The cost.** A remote agent gated on the conversation must keep that decision in a memo:

```ts
const offer = await ctx.memo(ctx.turn?.id ?? null, async () =>
  mentionsInvoices(await ctx.messages()),
); // restored from the binding, so it never reads the conversation there
if (!offer) return null;
```

Reading `ctx.messages()` outside a memo works before a model call and fails when eve later reaches
the child, with an error naming the file and suggesting the memo. eve builds a new child's
credentials from its binding before opening it, so the error appears on the first run.

<details>
<summary>How the binding is carried</summary>

- **Every path to the child carries it:** the steps that message, reset, and cancel the child, the
  route that follows its stream, and the relay that answers its questions.
- **It stays private.** It rides a private side stream on the parent session, written before the
  parent's `child.opened`, never a public fact or a request to the child.
- **Restores are strict.** A memo the child wasn't opened with, or a key that differs from the
  bound one, fails the request with an error naming the file.
- **The destination check holds across deployments.** If a new deployment's code returns a
  different name or URL for the same binding, the request fails rather than sending credentials
  elsewhere.
- **Folding the view costs about what a client pays to attach,** once per request or step, not per
  outbound call.

</details>

## How it fits together

The changes above are one model, seen from different sides. A definition is a function of a
**frame**, the session at a commit, and its **records**, the results of outside interactions kept
under a key. It returns what it wants to be true, and eve compares that with what's in place and
acts on the difference. A dynamic value returns a capability, and eve installs it. A hook handler
returns nothing; it reacts to a fact with ordinary code and can queue a cancellation.

```text
frame (session at a commit) ──┐
                              ├─► definition ─► desired value or effects ─► eve applies the difference
records (memos)      ─────────┘          ▲
                                         └── a new key runs fn and adds a record
```

Hooks fit the same model with a different trigger. A dynamic value is evaluated whenever a step
needs the value; a hook handler is evaluated once per fact, and its occurrence is the fact's
position, which supplies a stable idempotency key on retries. Internally, one runner evaluates
every definition, and one record store holds memos and queued cancellations. A kind only supplies how its value
joins the session.

## When things run

This is the contract authors can rely on, rather than an incidental order of internal callbacks.

- **eve evaluates only inside steps,** against the session's latest commit, where memo results can
  commit with the step. Today that's before each model call; a later step that needs a value
  follows the same rule.
- **Everywhere else, eve restores.** Today that's only remote children
  ([change 7](#7-remote-agents-are-restored-from-their-binding)). A request for what a session can
  do, such as agent info, reads what the last evaluation installed and never evaluates.
- **Hooks run after each commit,** inside a turn or between turns: each handler runs once for each
  matching fact the commit carries. Streamed progress, such as content deltas, reaches only handlers
  that subscribe to it by name, not `"*"`.
- **Hooks run first.** Before a model call, hooks finish with the latest commit before dynamic
  values run, as on `main`, so a hook that cancels stops the turn before any dynamic value fetches
  data. Hooks run in path order.
- **Only ordinary model calls count:** the first of each turn, the one after a batch of tool calls,
  and the one after an approval resumes. Compaction's summarizing call, the evaluator `auto()` asks,
  and `evaluate` inside a tool don't evaluate dynamic values.
- **A steering message is seen at the next model call.** It isn't a new turn, so memos keyed by
  `ctx.turn.id` don't run again, but code that reads `ctx.messages()` sees it.
- **Nothing is evaluated while a turn waits** for an approval or an answer. When an approval
  resumes, the approved calls run first, then dynamic values before the next model call.
- **Compaction changes what comes next.** The next model call sees the compacted conversation, so
  code over messages can change its answer: the image router switches back to text once a summary
  replaces the image.
- **A tool call runs only as it was offered.** A call that waits for an approval or a sign-in
  keeps a version of the dynamic entry it calls: a dynamic tool, a dynamic connection's tool, or a
  dynamic subagent. The version covers what the model was offered, a connection's target, or a
  subagent's selection, plus the memo results its definition was built from. If the version differs
  when the call runs, for example because the caller's role or tenant changed during the wait, the
  call fails with a tool error saying the tool changed since it was offered, and the model can
  request it again. Authorization is still checked when the call runs.

Evaluating a definition and installing its result in a model request are separate, which leaves
room to keep a provider's tool list stable where prompt caching benefits from it.

### After a cold start

```text
first evaluation:  function → memo runs fn → result kept → capability
                                                │
                                                ▼
                                          durable memo
                                                │
fresh process:     function → memo returns ◄────┘ → capability
```

A fresh process evaluates each definition again, and each memo returns its committed result. eve
doesn't query a database or ask a router again just to recover a capability. A memo that was
interrupted before its result committed runs again, with the same idempotency key.

eve then compares what the fresh evaluation offers with what the session was offered: tool
declarations, a connection's URL, instance key, and credential owner, and a remote agent's name and
URL. A difference means code outside the memos answered differently. The memos are still valid data,
so eve keeps them, offers the new value from this model call on, and logs a diagnostic naming the
file. Calls already requested from the old version fail, as described above. The comparison is a
check, not a proof that two callbacks behave the same.

### After a deployment change

At the move to a new deployment, which happens only while a session is idle, eve discards the memos
of dynamic values and hooks, and each runs again at its next evaluation. New code shouldn't build
from data it may not understand, and a once-per-session instruction shouldn't keep an outdated
policy just because it's plain text. So a memo keyed by `ctx.session.id` that captured the first
caller captures whoever is current after the change. `main` only re-resolves session tools and
subagents here; its session instructions, skills, models, and connections keep their old results.

User-instruction digests and remote-child bindings are kept. They record what already happened:
text that joined the conversation and a child that was opened. Event-handler occurrences that already ran don't run again either.

### What eve stores

- **Memos, instruction digests, and remote-child bindings are private.** The first two live in the
  session's checkpointed state, and bindings in a private side stream. None reach
  the public stream.
- **Stored state rides along every step.** A step's input and result carry the session's state, so
  records are re-sent and saved again on each step. `main` has the same cost for its closure
  snapshots, which it stores per callback with no cap.
- **Diagnostics go to logs, and later traces.** Each memo run reports the file, the key's
  digest (never the key, which can hold tenant or principal IDs), why it ran (a new key or a
  deployment change), and how long it took. Each evaluation reports whether the value changed.
  There's no public API for them at first.

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
  model: defineDynamic(async (ctx) =>
    (await ctx.messages()).some(hasImage) ? "google/gemini-3.5-flash" : "zai/glm-5.2",
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
`model: await ctx.memo(ctx.session.id, () => ctx.model.id)`. A subagent that doesn't depend on the
session at all is defined at module scope and returned from the function
([Static parts of a dynamic value](#1-a-dynamic-value-is-one-function)).

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

  const accounts = await ctx.memo(principal.principalId, () => listEnabledAccounts(principal));
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
`listEnabledAccounts` runs once per caller. The token is minted by `getToken` when it's needed, and
never kept.

</details>

<details>
<summary>One tool per warehouse table</summary>

This is [change 2](#2-ctxmemo-keeps-what-eve-learns-from-outside), with the tool built inline:

```ts
// agent/tools/query.ts (proposed)
export default defineDynamic(async (ctx) => {
  const tables = await ctx.memo(ctx.session.id, async () =>
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
        ctx.cancel("Workspace credentials are unavailable.");
      }
    },
  },
});
```

The cancel takes a reason, and calling it after the handler settles throws instead of being
ignored. Without the `try`, the turn fails rather than continuing without the check.

</details>

<details>
<summary>Hooks that observe</summary>

Audit, persistence, and sandbox-stopping hooks stay event handlers with side effects. They read
event payloads and committed session state; a hook that read the assembled conversation moves to
those inputs. A side effect that must happen once per fact uses the handler's
`ctx.occurrence.idempotencyKey` instead of coordinates copied from `event.data`.

</details>

## Alternatives

Four examples cover what differs between the designs: tools built from fetched data, a decision
per turn, a remote agent whose credentials are needed outside a model call, and a hook that acts
when state crosses a line. The event-keyed design and `select`/`record`/`render` are shown on all
four. The others are shown on the example that decides them.

### Event-keyed resolution

The design closest to today keeps lifecycle events as the way a definition says when it runs, and
fixes today's other problems: what the definition resolves is kept as data, a separate `build`
turns it into code, and the latest event's result replaces the one before.

<details>
<summary>The four examples, event-keyed</summary>

```ts
// tools from a warehouse
export default defineDynamic({
  on: ["session.started"], // latches the first caller's tables
  resolve: async () => (await listTables()).map(({ name, columns }) => ({ name, columns })),
  build: (tables) => Object.fromEntries(tables.map((t) => [t.name, tableTool(t)])),
});
```

```ts
// a router per turn
model: defineDynamic({
  on: ["turn.started"],
  resolve: async (ctx) => chooseTier(await ctx.messages()),
  build: (tier) => models[tier],
}),
```

```ts
// a remote agent per tenant, following the current caller
export default defineDynamic({
  on: ["model.requested"], // the only event that sees every change of caller
  resolve: async (ctx) => {
    const tenantId = ctx.session.auth.current?.attributes.tenantId;
    return tenantId ? await tenants.lookup(tenantId) : null; // before every model call
  },
  build: (tenant) => (tenant ? financeAgent(tenant) : null),
});
```

```ts
// a budget alert
const alerted = defineState("budget-alert.sent", () => false);

export default defineHook({
  events: {
    async "model.settled"(_event, ctx) {
      if (spentUsd(ctx.view) <= 50 || alerted.get()) return;
      await email.send({ template: "budget", idempotencyKey: `${ctx.session.id}:budget` });
      alerted.update(() => true);
    },
  },
});
```

</details>

**Pros.**

- **Timing is explicit and easy to audit.** A definition runs only on the events it lists, which
  is cheaper than evaluating in every step, and its cost is visible in the file.
- **One vocabulary.** Definitions, hooks, and the stream all speak in the same event names.
- **The smallest migration.** Most of today's definitions keep their event and split into
  `resolve` and `build`.
- **Restoring is structural.** eve calls `build(record)` outside a step without running anything
  else, so a remote agent's gate on the conversation costs nothing to restore.

**Cons.**

- **Following inputs that aren't events costs every model call, or a selector.** There's no event
  for "the caller changed", so to track the current caller a definition keys on `model.requested`
  and runs before every call. Running less often needs a comparison of what changed, which is a key
  by another name. Keying on `turn.started` instead misses steering and sign-ins mid-turn, which
  is today's bug.
- **Authors have to know which events can change their inputs:** steering, a completed sign-in, a
  new caller, compaction. Each new case adds to the event list, which is public API.
- **Several listed events need a merge rule,** and that brings back precedence.
- **Every value is two callbacks,** including the common one that only reads the session.
  Hooks keep their own memory for effects such as one budget alert per session in either design.

This proposal can express the event-keyed model, because an event's position is a key: "once per
`turn.started`" is `ctx.memo(ctx.turn.id, …)`. The reverse doesn't hold: a key such as a tenant ID
has no event.

### `select`, `record`, and `render`

[#4616](https://github.com/vercel/eve/pull/4616) prototypes this. `select` is a synchronous
function returning the JSON the value depends on, with `once`, `perTurn`, and `perStep` helpers.
`record` runs when the selection changes, and its JSON result is kept. `render` builds the value
from the record. Hooks use `select` with `run`.

<details>
<summary>The four examples, with select, record, and render</summary>

```ts
// tools from a warehouse
export default defineDynamic({
  select: once,
  record: async () => (await listTables()).map(({ name, columns }) => ({ name, columns })),
  render: (tables) => Object.fromEntries(tables.map((t) => [t.name, tableTool(t)])),
});
```

```ts
// a router per turn
model: defineDynamic({
  select: perTurn,
  record: async (_turn, ctx) => await chooseTier(await ctx.messages()),
  render: (tier) => models[tier],
}),
```

```ts
// a remote agent per tenant
export default defineDynamic({
  select: ({ session }) => session.auth.current?.attributes.tenantId ?? null,
  record: async (tenantId) => (tenantId === null ? null : await tenants.lookup(tenantId)),
  render: (tenant) => (tenant === null ? null : financeAgent(tenant)),
});
```

```ts
// a budget alert
export default defineHook({
  select: ({ view }) => spentUsd(view) > 50,
  run: async (over, ctx) => {
    if (over) await email.send({ template: "budget", idempotencyKey: ctx.occurrence.id });
  },
});
```

</details>

**Pros.** The separation of data and code is structural: `select` can't `await`, and eve restores
a value by calling `render(record)` with no context at all. A key such as a tenant ID is natural in
`select`.

**Cons.** Three callbacks for one idea read worse in the common cases, which need no data and fit
in one function. `render` doesn't stay pure in practice: in the prototype, memory tools render
through a provider's async `tools()`, so the guarantee leaks at the package boundary where it
matters most. A definition that loops over accounts has to fetch everything in one `record`.

### Other designs

- **Generators.** `function*` definitions that `yield*` each memo can't `await` anything else, so
  I/O outside a memo is impossible, and eve can throw into the generator, so `try` still works. But
  every helper that needs a memo becomes a generator too, package APIs are async anyway, and few
  authors know the syntax.

  ```ts
  export default defineDynamic(function* (ctx) {
    const tables = yield* ctx.memo(ctx.session.id, listTables);
    return Object.fromEntries(tables.map((t) => [t.name, tableTool(t)]));
  });
  ```

- **Automatic dependency tracking,** as with signals: a memo runs again when what it read changes,
  with no key. The router per turn breaks, because it reads the conversation and would decide
  before every model call. The lifetime and the dependencies are often different things.
- **Suspending memos,** like React's `use`: a synchronous function where a memo without a result
  suspends, and eve runs it again when the result arrives. That makes `await` outside a memo
  impossible, but a `try` around a memo, the pattern for optional capabilities, would catch the
  suspension.
- **Code by name:** the definition returns data, and a fresh process finds the code through a
  factory registered under a stable name, the way `pi-durable` resolves code. Recovery is exact, but
  every factory needs a name and registration: a parallel API, like `defineDurableCallback`, for
  every package that ships tools.
- **Compiler closure conversion,** as on `main`. Automatic, and it saves every capture, but it
  restricts what callbacks may look like and costs a compiler. A lint for `await` outside a memo
  would recover some of its safety without one.
- **Decisions as public facts.** Recording a router's choice or a tenant lookup on the stream would
  show it to clients, but exposes private data and grows the public schema. Memos stay private; a
  specific decision can become a fact when a client needs it, as the chosen model already appears
  in `model.started`.

### What this doesn't model

- **Memory recall** accumulates each turn's recall and places it ahead of that turn's input without
  keeping it in history. Its output depends on its own earlier outputs, not only on the session and
  its memos, so it stays an internal kind. Memory capture also stays internal, because it reads the
  conversation, which hooks don't.
- **Field-level dynamic values,** such as `available` or a dynamic `description`, would be a second
  way to vary a capability.
- **Time passing without a commit.** Hooks run after commits, so "remind after an
  approval has waited 30 minutes" never fires on its own. A command that schedules a later commit
  would fit the model, and can come later.

## What this removes

On `main`, recovering dynamic tools and remote credentials takes a compiler. About 1,060 lines of
build transforms under `internal/workflow-bundle/dynamic-*` parse authored source, find what
callbacks capture, and rewrite them into registered factories. About 1,020 more, in
`tools/durable-callbacks.ts` and `context/dynamic-tool-lifecycle.ts`, register and rebind them at
run time, alongside `defineDurableCallback` and `defineDurableSchema` for code the compiler can't
see. Memos need none of it, and builds stop parsing authored source.

The rest follows from having one model:

- **Six lifecycles do one job six times.** Each decides when to run, where to keep its result, how
  a later result replaces an earlier one, and how to recover after a restart, with its own rules.
  One runner does it once; a kind only supplies how its value joins the session.
- **Precedence and replay rules disappear.** Turn results shadowing session results, steering
  skipping `turn.started`, and re-running handlers to rebind callbacks are cases one function per
  value doesn't have, and neither do their tests.

## Scope

The first change, on the v27 view:

- `defineDynamic(fn)` for every kind that takes a dynamic value today, with `ctx.memo`.
- `ctx.memo`, `ctx.occurrence.idempotencyKey`, and `ctx.cancel` in hook handlers.
- The error rule, the user-instruction rule, and remote-child bindings with the folded view.
- `auto()`, memory tools, and schedule tools rebuilt on the new runner. Memory recall and capture
  stay internal kinds.
- The function form of a remote agent's `url` is replaced by a dynamic file.
- `defineDynamic` takes only a function. The `build` option on dynamic subagents goes; packaging
  configuration such as `build.externalDependencies` is declared on the root agent.

Moving #4616 to this API changes its definitions and hook kind: the runner keeps records per key
rather than one record per definition, select-form hooks go, hook commands become methods
on the queue it already has, and remote credentials come from running the definition with the
child's binding rather than calling `render`.

Not included: `ctx.once` and hook-side `ctx.compact` (both can be added later), field-level
dynamic values, a command that schedules a later commit, testing helpers
for hooks and dynamic values, an `onError` option, the conversation in hooks, a lint for `await`
outside memos, dependency graphs between definitions, a command for adding messages, or a new
task-authoring API.
