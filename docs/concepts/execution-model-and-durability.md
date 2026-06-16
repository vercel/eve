---
title: "Execution Model & Durability"
description: "How a session runs: durable conversations, turns that checkpoint at steps, and parked work that resumes later."
---

A session is a durable conversation. It can run for days, and it survives process restarts and redeploys without any work on your part. You write the capabilities (tools, instructions, channels) and Eve runs the loop.

## Sessions, turns, and steps

Work nests in three levels:

- **session**: the whole durable conversation or task. It's long-lived and can span many requests over days or weeks without losing context.
- **turn**: one user message and all the work it triggers (model calls, tool calls, reasoning) until the agent produces its response.
- **step**: a durable checkpoint inside a turn (one model call and the tool calls it makes).

Every turn runs as a durable workflow, built on the open-source [Workflow SDK](https://workflow-sdk.dev/) (Vercel Workflow when you deploy on Vercel). Eve checkpoints progress at each step and serializes durable state at that boundary. Your code runs inside a managed step, so tools, the sandbox, and subagents feel synchronous even though the session underneath them is durable.

## Resuming after a crash

Crash the process, hit a timeout, or redeploy mid-turn, and the run picks up from the last completed step rather than replaying the whole turn. Re-running a step from the same input is idempotent. Your tool calls don't fire twice, so a resume never doubles up a side effect (a charge, an email, a write).

There's nothing to configure here. Eve owns the workflow lifecycle, and sessions are durable by default.

You don't write workflow code directly. Workflow primitives (`start()`, `resumeHook()`, etc.) are an implementation detail of Eve's runtime layer; channels, tools, and hooks never touch them. When you do need session data from your own code, there are two supported surfaces: tools read the current session's metadata (id, turn, auth, parent lineage) via `ctx.session`, and [`defineState`](../guides/session-context) reads or writes session-scoped durable state. See [State](../guides/state) for the read/write model.

## Parked work

Some work has to wait: a human approving a [tool](../tools), an interactive OAuth sign-in for a [connection](../connections), or a long-running [subagent](../subagents). At those points the turn parks durably. The workflow suspends and holds no compute until the input it's waiting on shows up (a click, a callback, a child completing), even if that's much later. When it does, the conversation picks up exactly where it left off.

## Message delivery and queueing

Eve does not maintain a durable FIFO queue of user messages for a session today. The `continuationToken` is a resume handle for the session's current workflow hook, not a general message-queue address.

When a session is waiting, a delivery to the current continuation token wakes the session and starts the next turn. When a turn is already active, additional deliveries may be accepted by the hook, but the runtime only drains them at specific workflow boundaries. If more than one delivery is already ready when the driver checks, Eve may fold them into the next turn; that drain is best-effort and depends on workflow and transport timing.

That means applications should not rely on concurrent sends to the same session behaving like a typical ordered chat queue. For deterministic behavior, send one user turn at a time: wait for `session.waiting` before sending the next message to the same session. If your channel can receive bursts while the agent is working, keep your own per-session queue in the channel or app layer, then deliver the next message after the session parks again. Separate sessions can still run independently.

## Subagents

A turn can hand work off to a [subagent](../subagents). Each subagent gets its own context and its own durable session; a declared subagent also gets its own sandbox, skills, and state. Nothing crosses the boundary implicitly.

## Ordering

Conversation history within a session is append-only. Turns land in order, and the tool calls inside a turn (plus their results) keep their order too. Read a session back and you see things in the order they happened.

## What to read next

- [Sessions, runs & streaming](./sessions-runs-and-streaming): the handles you hold and the event stream you watch.
- [Security model](./security-model): the trust boundaries the runtime enforces.
- [State](../guides/state): durable per-session memory that persists across step boundaries.
