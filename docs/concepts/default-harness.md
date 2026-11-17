---
title: "Default Harness"
description: "How eve manages model context and compaction during an agent turn."
---

The default harness is eve's built-in agent loop. It manages model calls, compaction, and tool execution. See [Built-in tools](./built-in-tools) for its model-facing defaults and opt-ins, and [Execution model and durability](./execution-model-and-durability) for how turns checkpoint and resume.

## Compaction

Compaction keeps a long session from overflowing the model's context window. The harness compacts when the conversation, plus the compaction prompt's estimated size, reaches `compaction.threshold` of the window. It then summarizes the older turns into a checkpoint and keeps going. Omit `compaction.threshold` to compact at `0.9`. Tune it under [`compaction`](../agent-config#compaction) in `agent.ts`:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  compaction: {
    threshold: 0.75,
  },
});
```

When history passes the threshold, eve summarizes the older turns. eve measures the space against the provider's last reported input token count, plus an estimate for new messages.

The summary prompt asks the compaction model to separate completed progress and decisions from remaining work. It also asks the model to keep the constraints, preferences, data, and references needed to continue. A later compaction passes the previous summary in full and replaces it with an updated one. Omit `compaction.model` to summarize with the active turn model.

After compacting, the harness keeps the summary plus recent messages (up to 20,000 tokens or half the threshold, with tool results shortened to 2,000 characters). If keeping full recent messages would exceed half the context window, the harness keeps only their text, or only the summary. The current user message is always kept; if it exceeds the budget on its own, the harness keeps its beginning and end and summarizes the middle.

If the agent's instructions, tools, and memory already exceed `compaction.threshold`, eve logs a warning and compacts only when the request exceeds the model's full context window. Shorten instructions, tools, or memory, or raise `compaction.threshold`, to restore threshold headroom.

If the instructions, tools, memory, and context alone don't fit the model's context window, eve doesn't call the provider. The turn fails with `COMPACTION_FAILED`, and the session can receive another message.

If the provider rejects a request as longer than the model's context window, the turn fails with `MODEL_CALL_FAILED` and a `hint`. The session can receive another message, and the turn's input stays in history.

The summary call retries transient provider errors like any model call. If it fails for another reason, the turn fails with `MODEL_CALL_FAILED` and the history stays uncompacted. After a transient error such as a 429, the session waits for the next message.

[Memory](../memory) stays outside history and is not summarized. Memory providers can capture history before compaction rewrites it, and recalled memory from earlier turns remains in context after the checkpoint.

Clients and channels can request compaction between turns with `ClientSession.compact()`, a channel route's `compact(address)`, or `attachSession(sessionId).compact()`. The request doesn't append a user message. If a turn is running, eve queues the request until that turn ends. On the stream, manual and automatic compaction are the same context change: `context.started` and `context.settled` with `kind: "compaction"`.

After either kind of compaction, eve moves the idle session to a fresh workflow run on the same deployment. This keeps a long session's run history from growing. See [Execution model and durability](./execution-model-and-durability#compaction-handoff).

To discard model-message history instead of summarizing it, call `clear()` on any of those handles. Clearing keeps the session identity, system prompt, configured tools and skills, [`defineState`](./state) values, limits, and sandbox. It removes recalled memory, but doesn't delete data from a memory provider's external store. On the stream, clear is a context change with `kind: "clear"`: `context.started`, then `context.settled`.

## What to read next

- [Built-in tools](./built-in-tools): review the default and opt-in framework tools and configure the model-facing tool set
- [Execution model and durability](./execution-model-and-durability): understand how turns checkpoint and resume
- [Context control](./context-control): choose what the model sees and when
- [Memory](../memory): recall context from earlier sessions on every turn
