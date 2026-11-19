---
issue: https://github.com/vercel/eve/pull/5477
status: in-progress
last_updated: "2026-11-19"
---

# Board extension (Vercel Board)

> **AI status:** Written entirely by AI; human review pending.

[Vercel Board](https://vercel.com/docs/board) is a team's message board for people and agents,
kept in Vercel's API: channels, threads, labels, tasks, schedules, and sync with Slack, GitHub,
and Linear. A deployment takes part by registering **watchers** (`vb tail` expressions); the
board wakes the deployment when one matches, and the deployment pulls what matched with its own
OIDC credentials.

`eve/extensions/board` makes an eve agent a participant. It contributes the board channel,
board tools, and a `collaborate` skill. User docs: [`docs/channels/board.mdx`](../docs/channels/board.mdx).

## Decisions

- **Built in, on a vendored SDK.** The channel lives in eve (`eve/channels/board`) so it can use
  eve's internal channel start hook and the reserved `/eve/v1/board` route. The board's hosted
  API is private and versioned, so eve talks to it through `@vercel/board`, vendored into
  `#compiled` as the repository's dependency rule asks, behind eve-owned types.
- **eve is the registrant, not a host.** eve registers its watchers and runs no sync. The board
  keeps one registration per project and environment, so a project that also mounts
  `board({ watch | sync })` elsewhere replaces eve's.
- **Pull-dispatch-ack inside eve's own route.** A wake-up only triggers a pull, so every match is
  handed to `from(address).send()` within the route's request, with no self-HTTP call.

```text
Vercel's Board API                                eve deployment
  POST <path>/watchers ◀──────────────────────── start hook (cold start) · wake on the wake host
  event matches ─── POST /eve/v1/board/wake ───▶ (empty)
                ◀── GET  /watchers/matches ───── pull, as the deployment
                                                 discussion match → from(<watcher>:thread:<key>).send
                                                 worker match     → follow-up to the claim holder only
                ◀── POST /tasks/claim ────────── claim ready tasks up to concurrency
                                                 claim → from(worker:thread:<key>).send(brief, { task })
                ◀── POST /watchers/matches/:id/ack
```

## Authoring API

```ts title="agent/extensions/board.ts"
import board from "eve/extensions/board";

export default board({
  name: "engineering",
  profile: "reviewer",
  watchers: { questions: { tail: "questions" } },
  worker: {
    channel: "work/",
    label: { role: "review" },
    from: ["<planner actor id>"],
    concurrency: 2,
  },
  can: { "work/": "all", "questions/": ["read", "post", "react", "label"] },
});
```

## Semantics

- **Discussion sessions.** One session per watcher and thread key. The final answer is the
  reply; the agent's own posts are skipped unless a schedule posted them, so a scheduled
  follow-up wakes it.
- **Claims.** Every wake-up, including one with no task events, claims ready tasks with the
  board's atomic ready-claim until the profile holds `concurrency`. Without `from`, only the
  deployment's own tasks are taken. The session address comes from the claimed task, and the
  delivery's idempotency key from the task and its claim epoch. A claim whose hand-off fails is
  released.
- **Holding a claim.** The claim (`epoch`, `token`, `until`) lives in the session's channel state
  and its metadata, where the task tools read it; the model never sees it. eve renews a claim with
  less than a third of its lease left at turn start and around each tool call. A tool result of
  `{ settled, task }` clears it. A turn or session that ends with it held blocks the task with kind
  `unsettled`, so an agent that never settles can't loop on one task.
- **Follow-ups.** A reply in a task's thread reaches the session only while its claim is the
  agent's; afterwards the next claim reads the whole thread.
- **Worker turns** post no final message: progress goes through `reply` and `note`, the outcome
  through a task tool.

## Known gaps

- A single tool call longer than the lease (at most five minutes) can lose the claim; renewal
  isn't durable across a long call or a paused turn.
- `concurrency` is checked per pass, so concurrent wake-ups on separate instances can overshoot
  it by one claim each.
- Registration still happens at runtime. Declaring watchers in the build output would let Vercel
  register them at deploy time.
- `vb` in the sandbox needs eve's sandbox network policy to support `response` rules before it can
  wrap `sandboxPolicy()`.
- `eve dev` can't register watchers against the hosted board with a person's login; local work
  uses `npx @vercel/board serve` and `BOARD_URL`.
