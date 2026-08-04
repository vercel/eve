---
title: "Persistence"
description: "Store stream events in your own database, load them back, and reconstruct a chat."
---

eve already persists every session durably. The event stream is recorded before a step completes, survives crashes and redeploys, and can be replayed at any time — see [Execution model & durability](../concepts/execution-model-and-durability) and [Sessions, runs & streaming](../concepts/sessions-runs-and-streaming). You do not need your own database to make an agent durable.

You need one when the data has to outlive or outreach the session: a chat history screen in your product, a sidebar of named conversations per user, analytics, audit. This guide covers what to store, a schema that works for a chat product, how to write events into it, and how to turn stored events back into a rendered conversation.

## What to persist

A chat product persists three things, each with its own job:

1. **A chat row.** Your app-owned conversation: the id in your URLs, the title in the sidebar, the owning user. eve has no chat concept — the session is a runtime handle, and one chat can span several sessions over its lifetime.
2. **The session cursor.** The [`SessionState`](./client/continuations) object (`sessionId`, `continuationToken`, `streamIndex`). It resumes the conversation and reconnects the stream. It is a cursor, not a transcript.
3. **The event log.** The ordered [`MessageStreamEvent`](../concepts/sessions-runs-and-streaming)s for the chat, keyed by `meta.id`. It renders history without replaying the live stream.

## A schema for chat

```sql
create table chats (
  id            text primary key,
  user_id       text not null,
  title         text,
  session_state jsonb,                     -- latest SessionState cursor
  created_at    timestamptz not null default now()
);

create table chat_events (
  seq        bigserial primary key,        -- your ingestion order
  id         text unique not null,         -- meta.id
  chat_id    text not null references chats (id),
  session_id text not null,
  type       text not null,
  data       jsonb,
  emitted_at timestamptz not null
);
```

Two choices in this schema carry the weight:

- **`id` is unique, and every insert is `on conflict (id) do nothing`.** Each event carries a stable [`meta.id`](../concepts/sessions-runs-and-streaming#the-event-envelope) — an `evt_`-prefixed ULID minted once when the event is written to the durable stream. Reconnects, rewinds, and replays return the same id for the same event, so re-ingesting an overlap is a no-op instead of a duplicate row.
- **`seq` is yours, and reads order by it.** Ids are broadly time-ordered but not a total order: steps of one session can run in different processes, and two events in the same millisecond can sort either way. Ingest the stream in order and let your own sequence record it. Do not sort or page by `id`.

Events carry both `chat_id` and `session_id`. Sessions end — they expire after 30 days by default, and a completed or failed session cannot accept another message — but the chat row lives on. When the next message starts a fresh session, insert its events under the same `chat_id` and overwrite the chat's `session_state` with the new cursor. The full history stays in one place.

## Store events

There are two places to write events from. Pick by who knows the chat id.

### From the client

The client created the chat row, so it knows `chat_id`. With [`useEveAgent`](./frontend/overview), persist each event as it arrives with `onEvent`, and snapshot the cursor when the turn settles with `onFinish`:

```tsx
const agent = useEveAgent({
  onEvent: (event) => {
    void fetch(`/api/chats/${chatId}/events`, {
      method: "POST",
      body: JSON.stringify(event),
    });
  },
  onFinish: (snapshot) => {
    void fetch(`/api/chats/${chatId}`, {
      method: "PATCH",
      body: JSON.stringify({ sessionState: snapshot.session }),
    });
  },
});
```

Your API route inserts the event with `on conflict (id) do nothing` and stamps `chat_id` and `session_id` itself. From a script or backend service, the same loop is a [`session.stream()`](./client/streaming) iteration with an insert per event.

### From a hook

A [hook](./hooks) observes every event server-side, after it is durably recorded, across every channel — no client cooperation needed:

```ts title="agent/hooks/persist.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "*"(event, ctx) {
      await db.query(
        `insert into chat_events (id, chat_id, session_id, type, data, emitted_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (id) do nothing`,
        [
          event.meta.id,
          await chatIdForSession(ctx.session.id),
          ctx.session.id,
          event.type,
          "data" in event ? event.data : null,
          event.meta.at,
        ],
      );
    },
  },
});
```

A hook sees only `ctx.session.id`, not your chat id, so the mapping is yours to maintain: record `sessionId → chatId` when the client first learns its `sessionId` (the `onSessionChange` callback, or `session.state` after `send()` returns).

One semantic to know: `meta.id` makes re-_reading_ safe, not re-_running_. If a step is interrupted and retried, the new attempt emits new events with new ids, and the hook fires again for each. For stored content that is the behavior you want — key on `meta.id` and accept that an interrupted turn leaves both attempts in the table. For side effects that must happen once, key on the coordinates in `event.data` instead. [Hooks](./hooks#persist-events-to-your-own-database) covers the split in detail.

### Skip the deltas

The stream includes an incremental `message.appended` and `reasoning.appended` event per text delta. They are for live rendering; the finalized text arrives again on `message.completed` and `reasoning.completed`, and the default reducer renders history correctly without the deltas. Filtering them out of persistence keeps the table a fraction of the size:

```ts
if (event.type !== "message.appended" && event.type !== "reasoning.appended") {
  await persist(event);
}
```

### Backfill from the stream

The durable stream is the source of truth and your table is a copy, so you can rebuild it — after adding the hook to an existing deployment, or after losing rows. Rewind to the start and do a catch-up read that stops at the tail instead of following the live stream:

```ts
const session = client.session({ sessionId, streamIndex: 0 });

for await (const event of session.stream({ follow: false })) {
  await persist(event); // on conflict (id) do nothing
}
```

Because inserts key on `meta.id`, a backfill that overlaps rows you already have is harmless.

## Load a chat

Loading is two reads:

```sql
select session_state from chats where id = $1;
select id, type, data, emitted_at from chat_events where chat_id = $1 order by seq;
```

Reassemble each row into the event shape the client and reducer expect — `{ type, data, meta: { id, at } }`.

## Reconstruct the conversation

### In the browser

Hand both saved pieces to `useEveAgent`. The events render the history; the cursor resumes the conversation:

```tsx
const agent = useEveAgent({
  initialEvents: saved.events,
  initialSession: saved.sessionState,
});
```

`initialEvents` must be an ordered prefix of the session's stream, but its endpoint does not have to line up exactly with where the stream resumes: the store drops any event whose `meta.id` it has already applied, so an overlap renders once and `onEvent` only fires for events your UI has not seen.

`initialEvents` and `initialSession` are read when the hook creates its store, so remount the chat component when the user switches threads — `key={chat.id}` in React.

### Anywhere else

The projection that turns events into messages is a plain reducer, exported from `eve/client` as `defaultMessageReducer`. Fold it over the stored log to get `EveMessage[]` — AI SDK `UIMessage`-compatible — for server rendering, exports, or summaries:

```ts
import { defaultMessageReducer } from "eve/client";
import type { MessageStreamEvent } from "eve/client";

function messagesFrom(events: readonly MessageStreamEvent[]) {
  const reducer = defaultMessageReducer();
  return events.reduce(reducer.reduce, reducer.initial()).messages;
}
```

The reducer does not deduplicate — it trusts its input. The `unique (id)` constraint at ingestion is what guarantees each event appears once.

## Resume the conversation

The saved cursor is all a follow-up needs. In the browser, `initialSession` covers it. From a script or backend, pass the state to [`client.session()`](./client/continuations):

```ts
const session = client.session(savedSessionState);
const response = await session.send("Pick up where we left off.");
await response.result();
```

If all you persisted is `sessionId`, recover the current continuation token by reading the latest durable event — a waiting session's last event is `session.waiting`, which carries it. See [Continuations](./client/continuations#reconnect-an-existing-stream).

When a session has completed, failed, or expired, the client resets and the next `send()` starts a fresh durable session. Keep the chat row, record the new `sessionId` against it, and keep inserting events under the same `chat_id`. The new session's model context starts empty — history in your database is for rendering, not model memory. If the new session should know what came before, send a summary in the first message or provide it through [session context](./session-context).

## What to read next

- [Sessions, runs & streaming](../concepts/sessions-runs-and-streaming): the event vocabulary and the `meta.id` contract
- [Hooks](./hooks): server-side observation, retries, and idempotency keys
- [Continuations](./client/continuations): `SessionState` in depth
- [Frontend](./frontend/overview): `useEveAgent`, `initialEvents`, and resumable browser chat
