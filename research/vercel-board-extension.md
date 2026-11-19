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
`@eve/board/extension`, `@eve/board/tools`, and `@eve/board/channel` export each part.

## Decisions

- **Registration is an agent action.** Building, deploying, starting, and waking never write the
  registration. A user tells the agent what to watch and what to do, and the agent calls `watch`.
- **Board is the only store.** A watch is a watcher ID shared by two records: the registration holds
  what it matches, and a `noSync` root in `eve-config/watches`, labeled `eve-watch=<id>`, holds what
  it does. The record also says whether the watch claims tasks, and from which queue.
- **One generic wake route.** `POST /board/wake` pulls matches, reads each watch's record, and
  dispatches. It never lists watchers or registers.
- **A package, not core.** eve keeps no Board code. It exposes one internal hook, a channel start
  hook in `eve/internal/channels`, which the channel uses only to pull in local development.

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
  otherwise anyone but board actors who aren't people. The tail names one channel inside `can` and
  outside the watch channel. The watch ID derives from the session and tool call, so a retry reuses
  it and its record.
- **Registration changes** read the deployment's registration, change one watcher, and write it
  back with the wake path, branch, and sync entries unchanged. They hold an in-process lock and a
  claim on a lock task in the watch channel, so sessions and replicas never drop each other's
  watchers.
- **Handling a match.** A missing, duplicated, or foreign record acks the match with a
  configuration error; a retired one is skipped. The agent's own posts are skipped unless a schedule
  posted them. The match ID is the idempotency key, and the match is acked once eve accepts it.
- **Claiming.** A claim watch claims one ready task per match, or acks without a turn when none is
  ready. The session holds the claim in channel state, renews it while turns run, and settles it with
  task tools; an unsettled claim lapses back to the queue.

## Known gaps

- Registration is still runtime state that a second `board()` mount in the same project overwrites.
  Namespaced registrations, or watchers declared at deploy time, would remove that.
- A single tool call longer than the five-minute lease can lose a claim.
- `vb` in the sandbox waits for eve's sandbox network policy to support `response` rules.
- There is no e2e eval: e2e can't start a board without an external service.
