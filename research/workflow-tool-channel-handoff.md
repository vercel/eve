---
issue: TBD
status: in-progress
last_updated: "2026-10-20"
---

# Channel sessions from workflow tools

> **AI status:** Written entirely by AI; human review pending.

## Summary

A workflow tool can open a session with another agent through `ctx.agent()`, but it cannot start
or reach a session that belongs to a channel. That blocks model-driven handoffs such as forking a
conversation into someone's direct messages, or a Slack thread into a code channel
([#5092](https://github.com/vercel/eve/pull/5092)): the model decides inside a tool call, and the
new session must live at a channel address, answer people there, and outlive the tool.

Routes and schedules already reach channels with `ctx.to(channel, target).send()`, which goes
through the target channel's `receive()` hook. This proposal:

1. Adds `ctx.sendToChannel(name, message, { target, auth })` to workflow tool bodies, run as a
   durable step.
2. Adds `history` to `to().send()`, so a handoff can carry prior conversation.

Stacked on [#4477](https://github.com/vercel/eve/pull/4477), which adds `history`.

## Authoring API

```ts title="agent/tools/fork_to_dm.ts"
import { defineWorkflowTool } from "eve/tools";
import type slack from "../channels/slack";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Continue this conversation in the user's direct messages.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    "use workflow";
    const channelId = await openDirectMessage(ctx.session.auth.current); // "use step"
    const history = await readTranscript(ctx.session.id); // "use step"
    return await ctx.sendToChannel<typeof slack>("slack", "Continue here.", {
      target: { channelId },
      auth: ctx.session.auth.current,
      history,
    });
  },
});
```

The workflow body names the channel by its path-derived name (`agent/channels/slack.ts` →
`"slack"`), as `ctx.agent()` names agents. Importing a channel module into a workflow body would
evaluate the channel in the workflow sandbox. A type-only import keeps the target typed.

`sendToChannel()` starts a session seeded with `history` when the target address is free, and adds
`history` and the message to the owning session otherwise, following `turnPolicy` as route
`to().send()` does. It returns `{ sessionId }`, since session handles cannot cross the step
boundary.

### Why not `ctx.to()`

Routes and schedules use `ctx.to(channel, target).send()`, but a workflow body can't share that
contract: it names the channel by string, returns `{ sessionId }` instead of a `Session`, and each
`send` is a retried step. Sharing the name would suggest the same behavior.

It is one call rather than a handle. `ctx.channel(name)` would read like `ctx.agent(name)`, whose
handle is a session, but each call here resolves its target on its own: two sends to a Slack target
with only a `channelId` start two threads. `ctx.channel` also already names the session's channel
in hooks and dynamic resolvers. The verb leaves room for a `startInChannel()` once a step-derived
key exists (see [Non-goals](#non-goals)), and for a stateful handle later that sends follow-ups to
the session by id instead of running `receive()` again. The target goes in the options, as in the
Slack `onEvent` hook's `ctx.send(message, { target, auth })`.

## Semantics

### `history` through `receive()`

`receive(input, { from })` keeps deciding the address and state for a target. Its input gains
`history`, and eve adds it to the channel's `from(address).send()` when the channel passes no
`history` of its own. Existing `receive()` hooks need no changes. Routes and handler-form schedules
get `history` on `to().send()` too, since they share the `receive()` path.

### Workflow tool steps

Each `send()` runs as one `"use step"`. The step loads the deployment's root channels, finds the
channel by name, and runs its `receive()` with root-agent channel operations, outside the calling
session's context. Replay reuses the recorded result.

- **Ownership.** The session belongs to the channel, not the run. It has no parent, reports nothing
  back to the run, and does not end when the run finishes. This is the difference from
  `ctx.agent()`.
- **Auth.** `auth` is required and explicit, as in routes. Pass `ctx.session.auth.current` to act
  as the caller.
- **Subagents.** Only workflow tools on the root agent can use `ctx.sendToChannel()`; it throws
  in a subagent's tool. Channels belong to the root agent, so the session runs the root agent with
  all its tools, and a subagent must not reach tools its parent withheld from it.
- **Retries.** Each send carries an idempotency key from the step's `stepId`, which a retry
  keeps. eve adds it to the channel's `from().send()` calls that pass no key of their own, numbered
  per call. A retry that maps to the same address is deduplicated by the session there. A target
  the channel gives a new address each time (a Slack target with only a `channelId`, or an
  `initialMessage`) mints a new address on retry, so it still starts a second session, and
  platform posts made by `receive()` repeat.
- **Errors.** An unknown channel name, or a channel without `receive()`, throws in the step with the
  channel names available.

`ctx.sendToChannel()` exists only on workflow tool bodies. Ordinary tools run inside the turn's
step, where a retried call could deliver again with no recorded result to reuse.

## Non-goals

- A `startInChannel()` that starts a session only when the target is free. It needs `receive()`
  hooks to see the step's key and derive a stable address from it, so a retry finds its own
  earlier session and `created` stays true instead of reading as someone else's.
- Lineage (`forkedFrom`) on the new session. #5092 proposes it separately.
- A stateful handle that remembers the session after its first send, for `ctx.agent`-like
  follow-ups.
- `title` on the send. Route `to().send()` and `receive()` input have none; it should land on both.
- `ctx.sendToChannel()` in ordinary tools, hooks, or channel events.
- Reading another session's history. Workflow tools use `sessions.attach()` with
  `transcriptReducer()` in a step.
