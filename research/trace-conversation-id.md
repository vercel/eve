---
issue: "https://github.com/vercel/eve/issues/5932"
status: implemented
last_updated: "2026-11-13"
---

# Trace conversation ID

## Goal

Let a deployer choose the `gen_ai.conversation.id` that eve's spans record, so trace backends group work by the app's own conversation, without changing anything eve sends to the model.

An app thread can be served by several sessions over time, and one long-lived session can serve several callers in turn. Today the attribute is always the root session ID, and the only other source, `RunInput.conversationId`, is fixed for a session's life, can't be set by a channel for a root session, and is also the AI Gateway `sessionId`.

## API

```ts
import { otel } from "eve/instrumentation/otel";

export default otel({
  conversationId: ({ session }) => {
    const threadId = session.auth.current?.attributes.threadId;
    return typeof threadId === "string" ? threadId : undefined;
  },
});
```

`conversationId` receives `{ session }`, the existing `InstrumentationSession` that `runtimeContext` resolvers see (`id`, `auth.current`, `auth.initiator`, `parent`). It returns a string or `undefined`. It lives on `otel()` beside `tracePolicy` because it is process-wide trace configuration, not a per-destination setting.

## Semantics

- eve calls it synchronously when it binds instrumentation for a step, with the step's caller. A valid ID (the existing `readConversationId` rules: at most 1,024 bytes, no control characters) becomes the trace conversation ID for that step's spans and the third-party spans started inside them.
- `undefined`, an invalid ID, or a throw keeps the current ID; a throw logs a warning. Without the option, nothing changes.
- When a step keeps a running turn's caller instead of the delivering one (another person's answer, an ignored correction, mid-turn input without a message), the turn keeps its trace conversation ID too, so a responder's approval doesn't move the requester's turn into the responder's conversation.
- The ID is stored under its own context key. Only telemetry reads it: eve's turn identity, operation trace context, and the local `search_traces` tool. `ConversationIdKey` keeps the root session ID, so the AI Gateway `sessionId`, what subagents and remote agents inherit, and every model request are unchanged. Each session resolves its own ID.

## Alternatives

- Let channels set `RunInput.conversationId` for root sessions: fixed for the session's life and moves Gateway session routing and caching.
- Rewrite the attribute in a span processor: a processor doesn't see the step's caller, and eve's local trace tools would still group by the root ID.

## Known limit

The local trace spool releases a session's unfinished traces at session end by its root conversation ID. Traces recorded under a custom ID are released as their turns complete instead.
