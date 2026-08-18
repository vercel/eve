---
title: "Default Harness"
description: "How eve manages model context and compaction during an agent turn."
---

The default harness is eve's built-in agent loop. It manages model calls, compaction, and tool execution. Review the model-facing defaults and available opt-ins in [Built-in tools](./built-in-tools). To see how turns checkpoint and resume, read [Execution model and durability](./execution-model-and-durability).

## Compaction

The harness keeps a long session from overflowing the model's context window. Before comparing the conversation with `thresholdPercent` (`0.9` by default), it adds the estimated fixed envelope of the checkpoint prompt used for compaction. It then summarizes the older turns and keeps going. The prompt asks the compaction model to distinguish completed progress and decisions from remaining work and to retain the constraints, preferences, data, and references needed to continue. When eve compacts again, it passes the previous checkpoint separately and without the transcript's per-message truncation, then replaces it with the updated checkpoint. The summary uses the active turn model unless you override it. Tune when and how it kicks in under [`compaction`](../agent-config#compaction) in `agent.ts`:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  compaction: {
    thresholdPercent: 0.75,
  },
});
```

Compaction also preserves the framework's own tool state automatically. It resets read-before-write tracking (so a write afterward re-reads the file whose read evidence was summarized away) and re-injects the active todo list, so the model keeps its task list across the summary. There is no per-tool hook to configure.

Clients and channels can also request compaction between turns. Call
`ClientSession.compact()`, a channel route's `compact(address)`, or
`attachSession(sessionId).compact()`. The request does not append a user message;
if a turn is running, eve queues it until that turn settles. A successful manual
compaction emits the same `compaction.requested` and `compaction.completed`
events as automatic compaction, followed by `session.waiting`.

To discard model-message history instead of summarizing it, call the corresponding
`clear()` method on any of those handles. Clearing preserves the session identity,
system prompt, configured tools and skills, durable state, limits, and sandbox.
Its stream boundary is `context.cleared` followed by `session.waiting`.

## What to read next

- [Built-in tools](./built-in-tools): review the default and opt-in framework tools and configure the model-facing tool set
- [Execution model and durability](./execution-model-and-durability): understand how turns checkpoint and resume
- [Context control](./context-control): choose what the model sees and when
