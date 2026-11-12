---
issue: "https://github.com/vercel/eve/issues/5923"
status: implemented
last_updated: "2026-11-12"
---

# Memory recall after a mid-turn compaction

## Problem

Recall runs once per turn: the memory slot memoizes it on the turn, the
principal, and the latest clear. A long agentic turn can compact several times,
and every model call after a compaction reads the recall written at the turn's
start, before the compacted window existed. A provider that archives the window
in `capture["compaction.requested"]` can't tell the model that the window is
saved and how to search it, and a provider that injects a large index at turn
start can't swap it for a smaller one once the compaction has invalidated the
prompt cache anyway. Text returned from a tool is summarized away by the next
compaction, and an autonomous run may never get another user message. The
first-class memory proposal (#1510) had `recall["compaction.completed"]`; 0.84
(#4855) shipped without it.

## Authoring API

An optional recall handler beside `"turn.started"`:

```ts
defineMemoryProvider({
  recall: {
    "turn.started": async (ctx) => ({ messages: [{ id: "index", content: bigIndex }] }),
    "compaction.completed": async (ctx) => ({
      messages: [
        { content: "The earlier window is archived; search it with archive__search." },
        { id: "index", content: smallIndex },
      ],
    }),
  },
});
```

`MemoryCompactionCompletedContext` extends `MemoryOperationContext` with
`turn` (the turn the compaction ran in) and `compaction.modelId`. Its
`messages` are the compacted conversation, and `operationId` ends with the
compaction's position in the session stream, so each compaction has its own.

## Semantics

- **When:** after a compaction inside a turn completes and before the turn's
  next model call. A failed compaction doesn't run it. Between turns nothing
  runs; the next turn's `"turn.started"` recall stands in.
- **What the model reads:** the result joins the turn's recall instead of
  replacing it. A message with an `id` replaces the one recalled earlier with
  that `id` (in any turn, as a later turn's recall would); one without is
  added. Evaluating again without a new compaction adds nothing.
- **Failure:** like a throwing `"turn.started"` recall, it fails the turn
  (`REACTION_FAILED`) before the next model call is sent.
- **Without the handler:** nothing changes, including the memo key, so the
  provider still recalls exactly once per turn.

## Boundaries

After a compaction, the step evaluates only the context definitions keep (today
only memory recall) with the compacted conversation; tools, instructions, and
the model are not evaluated again until the next step, as before. The memory
slot reads the line of the latest _completed_ compaction from the definitions
state, which now records `context.settled:<kind>:completed` beside
`context.settled:<kind>`.
