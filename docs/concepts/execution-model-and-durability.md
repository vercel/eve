---
title: "Execution Model and Durability"
description: "How an eve session runs. Durable conversations, turns that checkpoint at steps, and parked work that resumes later."
---

An eve session is a durable conversation. It can run for days and survives process restarts and redeploys without any work on your part. You write the capabilities (tools, instructions, channels) and eve runs the loop.

## Sessions, turns, and steps

Work nests in three levels:

- **session**: the whole durable conversation or task. It's long-lived and can span many requests over days or weeks without losing context.
- **turn**: one user message and all the work it triggers (model calls, tool calls, reasoning) until the agent produces its response.
- **step**: a durable checkpoint inside a turn (one model call and the tool calls it makes).

Every turn runs as a durable workflow, built on the open-source [Workflow SDK](https://workflow-sdk.dev/) (Vercel Workflow when you deploy on Vercel). eve checkpoints progress and serializes durable state at each step boundary. Your code runs inside a managed step, so tools, the sandbox, and subagents feel synchronous even though the session underneath them is durable.

The Workflow SDK is not inherently tied to Vercel. In local development and in a self-deployed `eve start` process, eve uses the SDK's local world by default; that world persists workflow runs on disk under `.eve/.workflow-data` and dispatches through the same Nitro-hosted workflow routes. On Vercel, the same workflow code runs against Vercel Workflow instead, which adds platform features such as latest production deployment routing and dashboard run metadata.

When a Vercel production deployment changes, the next model turn in an existing session uses that deployment's current instructions, model, and tools. The durable session keeps its conversation history and authored state, so identity-based channels such as Telegram private chats and Twilio phone-number conversations adopt agent updates without requiring a new session.

Nitro hosts the HTTP routes and workflow entrypoints. It does not supply the workflow state store or the sandbox runtime. Those are separate adapters: Workflow uses the active world implementation, and Sandbox uses the backend from `agent/sandbox` or `defaultBackend()`.

For advanced self-hosted deployments, the root `agent.ts` can select the installed Workflow world package to use with `experimental.workflow.world`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  experimental: {
    workflow: {
      world: "@workflow/world-postgres",
    },
  },
});
```

The world package backs workflow state, queues, hooks, and streams. Keep secrets and deployment-specific options in runtime environment variables read by that package, not in `agent.ts`. Custom worlds must implement the runtime protocol expected by eve's vendored `@workflow/*` packages (currently the `5.0.0-beta` line); the Workflow SDK rejects incompatible protocol versions during initialization. See the [deployment guide](../guides/deployment#8-deploy-without-vercel) for the install command, plus [agent.ts](../agent-config#workflow-world) and [Workflow Worlds](https://workflow-sdk.dev/worlds).

## Resuming after a crash

Crash the process, hit a timeout, or redeploy mid-turn, and the run picks up from the last completed step rather than replaying the whole turn. Completed steps never re-run; eve replays the recorded result. A step interrupted mid-execution re-runs, so make non-idempotent side effects like charges or emails idempotent, or gate them with approval.

There's nothing to configure. eve owns the workflow lifecycle, and sessions are durable by default.

You don't write workflow code directly. Workflow primitives (`start()`, `resumeHook()`, etc.) are an implementation detail of eve's runtime layer; channels, tools, and hooks never touch them. Two surfaces give your own code session data: tools read the current session's metadata (id, turn, auth, parent lineage) via `ctx.session`, and [`defineState`](../guides/state) reads or writes session-scoped durable state. See [State](../guides/state) for the read/write model.

## Parked work

Some work has to wait, including a human approving a [tool](../tools), an interactive OAuth sign-in for a [connection](../connections), or a long-running [subagent](../subagents). At those points the turn parks durably. The workflow suspends and holds no compute until the input it's waiting on arrives (a click, a callback, a child completing), even if that's much later. When it does, the conversation picks up exactly where it left off.

## Message delivery and queueing

eve does not maintain a durable FIFO queue of user messages for a session. The `continuationToken` is a resume handle for the session's current workflow hook, not a general message-queue address.

Only one active session can own a continuation token. When a session starts with a token, eve commits the park hook before processing its first turn and fails a competing session if another run already owns that token. A tokenless session claims its token after the first turn establishes one. Competing input is not forwarded to the owner.

When a session is waiting, a delivery to the current continuation token wakes the session and starts the next turn. When a turn is already active, the hook may accept additional deliveries, but the runtime only drains them at specific workflow boundaries. If more than one delivery is ready when the driver checks, eve may fold them into the next turn; that drain is best-effort and depends on workflow and transport timing.

So don't rely on concurrent sends to the same session behaving like a typical ordered chat queue. For deterministic behavior, send one user turn at a time and wait for `session.waiting` before sending the next message to the same session. If your channel can receive bursts while the agent is working, keep your own per-session queue in the channel or app layer, then deliver the next message after the session parks again. Separate sessions still run independently.

## Subagents

A turn can hand work off to a [subagent](../subagents). Each subagent gets its own context and its own durable session; a declared subagent also gets its own sandbox, skills, and state. Nothing crosses the boundary implicitly.

## How eve orders session history

Conversation history within a session is append-only. Turns land in order, and the tool calls inside a turn (plus their results) keep their order too. Read a session back and you see events in the order they happened.

## What to read next

- [Sessions and streaming](./sessions-runs-and-streaming): the handles you hold and the event stream you watch.
- [Security model](./security-model): the trust boundaries the runtime enforces.
- [State](../guides/state): durable per-session memory that persists across step boundaries.
