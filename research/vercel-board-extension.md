---
issue: https://github.com/vercel/eve/pull/5477
status: in-progress
last_updated: "2026-11-19"
---

# @eve/board: tool-managed Board watches

> **AI status:** Written entirely by AI; human review pending.

[Vercel Board](https://vercel.com/docs/board) is a team's message board for people and agents,
kept in Vercel's API. A project takes part by registering **watchers** (`vb tail` expressions);
the board wakes the project when one matches, and the project pulls what matched with its own
OIDC credentials. `@eve/board` is a published package: its default export is the extension, and
`@eve/board/tools` and `@eve/board/channel` export the tools and the channel, which use the default
board settings outside the extension.

## Decisions

- **Registration is an agent action.** Building, deploying, starting, and waking never write the
  registration. A user tells the agent what to watch and what to do, and the agent calls `watch`.
- **Board is the only store.** A watch is a watcher ID shared by two records: the registration holds
  what it matches, and a `noSync` root in `eve-config/watches`, labeled `eve-watch=<id>`, holds what
  it does. The record's text ends in an `eve-watch` header naming the watch and its action (converse,
  or claim from a queue); the label is only a lookup index, because anyone with label access can
  change labels but only the author can change text.
- **`can` bounds the model, not the bookkeeping.** The board refuses registration, matches, and acks
  to a handle narrowed with `can`, so eve's own registration, records, lock, pulls, and claim
  settlement use the deployment's handle, and the watch tools enforce `can` on every tail and queue.
  Claims go through the narrowed handle, so the board never offers a task outside `can`.
- **A lean tool list.** `read`, `reply`, `post`, and `react` are in every request; the settle tools
  are a dynamic tool offered only while the session holds a claim; the rest are deferred behind
  `eve__search`, and an always-on instruction names them. The channel shows typing on every turn
  and call, so there is no typing tool.
- **One generic wake route.** `POST /board/wake` pulls matches, reads each watch's record, and
  dispatches. It never lists watchers or registers.
- **A package, not core.** The package needs no change to eve and supports eve 1.0.0 and later. A
  local board can't wake `eve dev`, so local development calls the wake route by hand.

## Lifecycle

```text
watch tool ── post record (idempotent id) ──▶ eve-config/watches   eve-watch=w-7k3p
           ── lock task claim ─ read registration ─ add w-7k3p ─ register ─ release
board event matches w-7k3p ── POST /board/wake ──▶ deployment
           ◀── matches ── record by label (one root, written by the agent, not retired)
               converse: send(<id>:thread:<thread>, message, instructions)   key board:<match>
               claim:    claim ready task ─ send(<id>:thread:<task thread>)    key board:task:<id>:<epoch>
           ◀── ack
unwatch tool ── lock ─ remove w-7k3p ─ register ─ release ── label record retired
```

## Semantics

- **Creating a watch.** The caller must be allowed to configure the agent: `configurers` when set,
  otherwise anyone but board actors who aren't people. The watch names one channel inside `can` and
  outside the watch channel, with optional label, author, and text filters that eve writes as
  the registration's tail. The watch ID derives from the session and tool call, so a retry reuses
  it and its record.
- **Registration changes** read the deployment's registration, change one watcher, and write it
  back with the wake path, branch, and sync entries unchanged. They hold an in-process lock and a
  claim on a lock task in the watch channel, so sessions and replicas never drop each other's
  watchers.
- **Handling a match.** A match whose record is missing, duplicated, foreign, or retired is
  skipped, with a logged warning unless the record is retired. The agent's own posts are skipped unless a schedule
  posted them. The match ID is the idempotency key, and the match is acked once eve accepts it.
- **Scope.** `can` is checked with the board's own precedence (exact channel, then the longest
  subtree, then `*`) on every delivered message and claimed task, not only when a watch is created.
- **Claiming.** A claim watch claims one ready task per task event, or acks without a turn when none is
  ready. The session holds the claim in channel state, never in metadata, and renews it while turns
  run, once less than a third of the lease is left: at turn and call boundaries, and on a 30-second
  timer, one per claim, while the session's in-process tool calls run. Subagent and workflow calls run
  outside the step, so eve renews the claim in full when one starts, unless it renewed in the last
  minute, so parallel subagents renew once. A task tool names the settlement and the channel performs it when a call from a settle tool
  settles, keeping the claim only when the board is briefly unavailable. A reply or the agent's
  own check-in in a held task's thread goes to that task's session. The claiming watch labels the task
  `eve-claim-watch=<id>`, so when two of the agent's claim watches cover a thread, only the one that
  holds the task takes its replies. A claim whose hand-off fails is
  released, and an unsettled claim lapses back to the queue. A turn answering a board-only message
  keeps its automatic replies board-only.

## Known gaps

- Registration is still runtime state that a second `board()` mount in the same project overwrites.
  Namespaced registrations, or watchers declared at deploy time, would remove that.
- A subagent or workflow call longer than the one-hour lease loses its claim, because nothing
  renews it while the parent session waits.
- `vb` in the sandbox waits for eve's sandbox network policy to support `response` rules.
- There is no e2e eval: e2e can't start a board without an external service.
