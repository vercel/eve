---
title: "Migrate Saved History"
description: "Re-read or convert session events your application stored before the upgrade, and remove state tracking eve now provides."
navTitle: "Saved History"
---

Read this page if your application stores session events in its own database or browser storage, or if it follows streams and tracks turn status with its own code. If you use `useEveAgent` or `SessionStore` and store nothing yourself, skip it.

This page is part of [Upgrade to 1.0](/docs/guides/upgrade).

## Re-read or convert saved events

The server's own copy of a stream needs no migration. A session that started on eve 0.69 through 0.83 keeps the lines it already stored, and when it moves to the new deployment, new v27 lines are appended after them. The new deployment serves the whole stream as v27 events, and cursors you saved still point at the same lines.

Copies your application saved itself are different. Events saved from 0.69 through 0.83 are v26 events, and `SessionStore` can't load them as `initialEvents`. Pick the path that matches what you have:

| What you have                                                          | Do this                                                                                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The session's stream is still available                                | Read it again from position 0 and replace what you saved.                                            |
| The saved array is the only copy                                       | Convert it once with `convertLegacyEvents` and store the result.                                     |
| A record with v26 events followed by v27 events, and an expired stream | Convert only the v26 prefix. Keep the later v27 events and their metadata unchanged.                 |
| Message lists produced by v26 reducers                                 | Don't convert them. Re-read the stream, or render the lists as read-only records.                    |
| Events saved from a release before 0.69                                | Keep them as read-only records. They aren't v26 events, so `convertLegacyEvents` can't convert them. |

```ts
import { convertLegacyEvents } from "eve/internal/legacy-events";

// One session's saved events, from its `session.started` on, as they were saved.
const events = convertLegacyEvents(saved);
```

Store the converted events with their metadata unchanged and pass them as `SessionStore`'s `initialEvents`. Their metadata records which saved lines they came from, including lines that produced no v27 events, and `SessionStore` uses it to resume reading at the right line. The number of converted events doesn't match the number of lines, so don't compute a resume position from it or from another reader's cursor. See [Resumable sessions](/docs/guides/frontend/overview#resumable-sessions).

`convertLegacyEvents` converts one session at a time. It throws for an array that doesn't start at `session.started`, holds a second session, or already holds v27 events. A session saved mid-turn converts to an unfinished turn. The function is a temporary migration aid with no compatibility promise, and a later release removes it, so convert once and store the result.

Before you hydrate or convert a saved record:

- **Select one session.** A chat record can hold several sessions, for example after a chat moves to a new session or a fork copies its parent's history. Pass only the current session's events, from its `session.started`.
- **End computed cursors at a complete line.** An event with `meta.endOfLine: false` has more events in the same line. Stop a cursor you compute at the last complete line.
- **Treat missing data as unknown.** A partial read must not overwrite a fuller archive, and an expired stream must not replace saved history with an empty one. A child session you can't read anymore hasn't necessarily completed.
- **Guard concurrent writes.** Browser saves, server catch-up reads, and background capture can race. Bind each write to its session, reject a cursor that moves backward, and track each child session's progress apart from its parent's.
- **Keep copied history read-only.** Approvals and sign-ins in a fork, shared copy, or old transcript belong to the original session. Render them as records, not live controls.
- **Qualify IDs with the session.** Turn and message IDs aren't unique across sessions. Include the session ID in keys when one record holds several sessions.

## Apps that track session state

If your application followed streams, folded events, or tracked turn status itself, much of that code duplicates what eve now provides. Decide what each piece of state is for:

| Let eve own                                       | Keep in your application                                           |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Turn status and what happens from start to finish | Saved archives and their cursors                                   |
| Streaming and reconnection                        | Forks and shared copies                                            |
| Optimistic sends                                  | Feedback, authorization, and policy for who may answer             |
| Pending approvals, questions, and sign-ins        | Budgets you wrote, and ledgers of external effects such as uploads |

Replace your own status tracking as a whole instead of layering it on `SessionStore`. A second reducer becomes another source of truth that can disagree with eve's. Map `messages`, `view`, and the message parts for approvals and questions into your existing components instead.

### Replace code eve owns

| Usually replaceable                                                    | Replacement                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Custom stream followers, reconnect loops, and optimistic-send state    | `useEveAgent` or `SessionStore`                                                                              |
| Hook or session state that mirrors turns, calls, tasks, or models      | `ctx.view` and selectors from `eve/events`                                                                   |
| Folds over raw events for status, replies, timing, usage, or cursors   | The queries in [Use eve's answers](/docs/guides/frontend/use-eve-agent#use-eves-answers)                     |
| Hand-written finite stream readers and history scanners                | `session.stream({ follow: false })` or `session.snapshot()`                                                  |
| Conversions from `Interaction` to a custom request shape and back      | Native `Interaction` values and the channel's interaction rendering                                          |
| Code that retires Slack approval cards and sign-in messages eve posted | Remove it; eve updates those Slack messages. Check each channel's docs before removing code for other cards. |
| An explicit `turnPolicy: "steer"` on follow-ups                        | Omit it; messages steer an open turn by default                                                              |
| Local v26-to-v27 event translators                                     | `convertLegacyEvents` during migration, or a fresh read from position 0                                      |
| Tests that only exercised removed machinery                            | Delete them with that machinery                                                                              |

Keep code that enforces your own rules. That includes archive storage and cursor guards, effect ledgers and deduplication receipts, authorization checks, budgets you wrote, `operationId` retries, and product UI such as composers, branches, and sharing.

### Attribute results to the right message

- **Bind each outcome to its delivery.** Use `delivery.result()` or that delivery's own turn, not the session's latest turn or every event after a polling cursor. Otherwise a queued or concurrent turn can claim another turn's output.
- **Follow child sessions by link.** For a child session that several calls reuse, follow the `child.sent` links from a call, for example with `agentCallActivity(state, callId)` from `eve/client`. Don't count `delivery.consumed` on the child's stream, because answers to the child's questions are deliveries too. See [Child agents](/docs/guides/frontend/use-eve-agent#child-agents).
- **Identify runs by ID.** A steering message adds a run to the same turn. A model retry before any output reuses its run ID, but a retry after output starts a new run with a new ID. Use `turn.started` for once-per-turn work, and `runId` with `turnId` for a specific run.
- **Treat acceptance as admission.** When an outcome is unconfirmed, read it again instead of resending after a timeout. Use `operationId` for create requests you retry; see [the eve channel](/docs/channels/eve).
- **Read payloads by their documented shape.** `turn.settled.data.reply` lists the reply's part IDs, not its text. Use `reply(ctx.view, turnId)` in hooks and channels, or `messages` in the frontend.

## Verify migrated history

- Build test fixtures from real saved history. Record v26 data with the release you're upgrading from, and pass it through a JSON round trip, so tests use the shape you actually store.
- Test each history path you support: expired streams, sessions saved mid-turn, forks, records holding several sessions, and records written across the upgrade.
- Test endings other than an answer: cancel a turn while an approval is pending, and send a message while a sign-in is pending.
