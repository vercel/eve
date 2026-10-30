---
title: "Harness"
description: "Decide how an agent's turns run from agent/harness.ts: what each model call gets, what the model remembers, and what the turn does next."
---

An `agent/harness.ts` file replaces parts of eve's own turn loop with your code. It default-exports `defineHarness((ctx) => plan)`, where the plan has three optional fields:

- `agent`: the model, tools, and instructions the next model call gets.
- `history`: what the model reads about the past, which becomes the session's history.
- `next`: what the turn does next: call the model, settle, or fail.

A field you leave out, or return `undefined` for, is eve's own behavior. A harness that sets only `next` keeps eve's prompt, tools, and compaction. This API is experimental and may change. Import it from `eve/experimental/harness`.

eve still applies its own checks to whatever the harness returns. Approvals, sign-ins, usage limits, and the turn's working tasks work as they do without a harness, and a harness can't skip them.

## Continue a turn before it ends

`next` runs after each model step. Return `{ model: { note } }` to show the model a note and call it again. The note joins the history as a user message.

```ts title="agent/harness.ts"
import { defineHarness } from "eve/experimental/harness";

export default defineHarness((ctx) => ({
  next: () => {
    const text = ctx.lastStep?.text;
    if (text == null || ctx.continuations > 0 || text.includes("[source]")) return undefined;
    return { model: { note: "Cite a source for each claim, as [source]." } };
  },
}));
```

`ctx.continuations` counts the notes this harness added to the running turn. eve caps notes at three per turn, counted as they're added, so a compaction that summarizes them away doesn't lift the cap. At the cap, eve's own loop decides.

## Answer without the model

`next` also runs before each model call, including at the start of a turn, when `ctx.steps` is `0`. Return `{ settle: { output } }` to end the turn with that reply, or `{ fail: { message } }` to end it as failed with a message for the person.

```ts title="agent/harness.ts"
import { defineHarness } from "eve/experimental/harness";

export default defineHarness((ctx) => {
  const input = ctx.turn?.input
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join(" ")
    .trim();
  return {
    next: () => {
      if (ctx.steps > 0) return undefined;
      if (input === "/help") return { settle: { output: "Ask about plans, seats, or releases." } };
      if (input?.startsWith("/refund")) {
        return { fail: { message: "Refunds go through billing@example.com." } };
      }
      return undefined;
    },
  };
});
```

While the turn's tasks are working, `settle` can't end it. eve waits for the tasks and calls the model with their results. Under an output schema, `settle.output` must match the schema, or the turn fails with `OUTPUT_SCHEMA_NOT_FULFILLED`.

In a turn under a harness, the model's answers are drafts until the harness settles. Each text part's first `content.delta` carries `draft: true`, since it may become one, and its `content.completed` says what it became: phase `"draft"`, or narration or a reply as usual. The turn's reply arrives as its own part. eve's channels, its client, and the ACP server hold flagged text until it completes and skip drafts, so a reply the harness rejects with a note is never posted.

## Set the model's tools and instructions

`agent` sets what the next model call gets. Each field is a value or a function eve calls only when it needs the value.

- `agent.instructions` is the whole system prompt. A string is used as it is. An array's entries are joined, and empty ones are skipped.
- `agent.tools` is every tool the model is offered.
- `agent.model` is the model.

Two functions give a harness eve's own pieces as data:

- `declared(ctx)` returns what the agent's files declare: `instructions` (the agent's own as `agent`, and each `agent/instructions/` file by slug), `skills` (each with `load()`), `tools` (including eve's default tools), the `workspace`, and the agent's `model`.
- `builtins(ctx)` returns eve's `eve__` tools, and `prompt`, the renderers of eve's default prompt: `instructions(files)` for the whole prompt, and `skills`, `workspace`, `tools`, and `tasks` for its parts.

This harness keeps eve's prompt and tools, and adds to both:

```ts title="agent/harness.ts"
import { builtins, declared, defineHarness } from "eve/experimental/harness";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineHarness((ctx) => {
  const plan = String(ctx.session.auth.current?.attributes.plan ?? "pro");
  return {
    agent: {
      instructions: async () => {
        const prompt = builtins(ctx).prompt.instructions(await declared(ctx));
        return [
          ...(typeof prompt === "string" ? [prompt] : prompt),
          `The customer is on the ${plan} plan.`,
        ];
      },
      tools: async () => {
        const { remove_seat, ...tools } = (await declared(ctx)).tools;
        return {
          ...tools,
          ...builtins(ctx).tools,
          // Only enterprise accounts can remove seats.
          ...(plan === "enterprise" && remove_seat !== undefined && { remove_seat }),
          plan_lookup: defineTool({
            description: "Look up what a plan includes.",
            inputSchema: z.object({ plan: z.enum(["free", "pro", "enterprise"]) }),
            execute: async ({ plan }) => ({ plan }),
          }),
        };
      },
    },
  };
});
```

A declared tool you offer keeps its name and approval. A copy may change its `description`.

Leaving out one of eve's `eve__` tools turns off what it serves. Without `eve__skill`, skills don't load. Without `eve__task_wait`, the model can't wait on tasks, though the turn still waits for them. Without `eve__reply`, the model can't deliver a structured result, so the harness settles the turn itself. eve offers each `eve__` tool you return only when it serves something: a skill, a deferred tool or connection, a task, or an output schema. When the harness offers `eve__search`, `eve__tool`, or `eve__skill`, eve tells the model what they reach in history messages, as it does without a harness. That includes deferred tools, connections, and skills added during the session.

When eve retries a model call after the provider rejected a tool, eve puts a note about it before your instructions. That note is the only system text eve adds to `agent.instructions`.

The agent's dynamic values (dynamic instructions, tools, and models) are evaluated only when the harness calls `declared(ctx)`, or leaves a field to eve.

## Decide what the model remembers

eve asks `history` before every model call and for `session.compact()`. What `history` returns becomes the session's history, the messages the model reads about the past. The [session stream](../concepts/sessions-runs-and-streaming) still records everything that happened.

- `ctx.size` is the next call's estimated input `tokens` and the model's context `window`, when eve knows it.
- `ctx.compact` is `true` when `session.compact()` asked for the history.
- `ctx.summarize(history, { tokens? })` is eve's summarizer: a checkpoint of the older turns, then the recent turns whole. Its model call is announced as a compaction run and counts toward the session's usage.

```ts title="agent/harness.ts"
import { defineHarness } from "eve/experimental/harness";

export default defineHarness((ctx) => ({
  history: () => {
    const { tokens = 0, window = Infinity } = ctx.size ?? {};
    // Compact at half the window, not eve's default threshold.
    if (ctx.compact || tokens > 0.5 * window) return ctx.summarize(ctx.history);
    return ctx.history;
  },
}));
```

How eve applies what `history` returns:

- If nothing changed, nothing is recorded.
- A change to messages the model hasn't read yet, such as a tool result that just arrived, joins the history with no compaction.
- A change to messages the model has read is a rewrite. eve checks it and records it as a compaction. Every user message must have a kind, every tool result must follow its call exactly once, and the turn's input must stay.
- Under `eve dev` and in tests, eve asks `history` again about the history it returned, and the answer must be the same.

`ctx.summarize` is available only inside `history`.

## What the harness reads

`ctx` is the session as of eve's latest commit, plus the [session frame](../guides/session-context) dynamic values read:

| Field                     | Meaning                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ctx.history`             | The history eve is deciding about                                                                                   |
| `ctx.turn`                | The running turn, with its `input`                                                                                  |
| `ctx.lastStep`            | The model step that just ended: `text`, `output`, and `endsTurn`. Absent before a model call                        |
| `ctx.calls`               | The turn's calls, oldest first: `kind`, `tool`, `input`, `status`, `outcome`, `output` when it's small, and `error` |
| `ctx.steps`               | Model calls the turn has made                                                                                       |
| `ctx.continuations`       | Notes this harness added to the running turn                                                                        |
| `ctx.size`, `ctx.compact` | Where eve asks for the history: the next call's size, and a `session.compact()` request                             |
| `ctx.memo`                | A cache across evaluations, like a dynamic value's `ctx.memo`                                                       |

`ctx.memo` is a cache, not a record of effects: a crash or a deployment can run its function again.

The function passed to `defineHarness` should be cheap and synchronous: it says what each field is. Put work in the lazy fields, which eve calls only when it needs them.

## When a harness fails

A harness that throws, or returns something eve can't apply, fails the turn with `HARNESS_FAILED` and the message "The agent's harness failed." The cause goes to the server logs only. Calling the model again with nothing new for it to read also fails the turn.
