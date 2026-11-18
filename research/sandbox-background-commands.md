---
issue: https://github.com/vercel/eve/issues/6553
status: implemented
last_updated: "2026-11-18"
---

# Sandbox timeout while in use, and background commands

> **AI status:** Written entirely by AI; human review pending.

## Summary

[Sandbox idle timeout](./sandbox-idle-timeout.md) made eve stop a sandbox once its session goes
idle, and deferred sizing the provider's own timeout by actual use. Two cases still end a process
that someone is waiting for:

| Case                                                   | What ends the process                        |
| ------------------------------------------------------ | -------------------------------------------- |
| A turn uses a Vercel Sandbox for more than 30 minutes. | Vercel's `timeout`, 30 minutes after resume. |
| `bash` leaves a command running, and the turn ends.    | The idle stop, 5 minutes later by default.   |

The first was reported from a production agent that trains models in its sandbox: the sandbox
"restarts about every 30 minutes", which ends the training run and everything else in the
sandbox. Vercel allows a session to run for 24 hours on Pro and Enterprise
([limits](https://vercel.com/docs/sandbox/pricing)); the 30 minutes is eve's fixed default, and eve
never extends it. Vercel resumes the sandbox on the next command, so the model sees a missing
process and no error.

This plan makes the sandbox's lifetime follow its use. A turn that keeps using the sandbox keeps
it running, and a command that `bash` left running keeps it running until the command exits, for a
bounded time.

## Authoring API

`backgroundTimeoutMs` is an option of every sandbox environment, beside `idleTimeoutMs`:

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const environment = VercelSandbox.environment({
  // optional: how long a command that bash left running keeps the sandbox running
  backgroundTimeoutMs: 6 * 60 * 60 * 1000,
});

export default defineSandbox(() => environment.open());
```

| Value   | Result                                                               |
| ------- | -------------------------------------------------------------------- |
| Omitted | A background command keeps the sandbox running for up to 30 minutes. |
| Number  | It keeps the sandbox running for up to that many milliseconds.       |
| `0`     | It doesn't keep the sandbox running, and the idle stop ends it.      |

- A background command is one that `bash` returned as `running`. A process that a finished command
  left behind, such as a server started with `&`, doesn't count, so a daemon can't hold a sandbox.
- The time counts from when `bash` returns. Each later command that `bash` leaves running counts
  from its own return.
- While the command runs and the time isn't up, eve doesn't stop the idle sandbox. eve stops it
  within 5 minutes of the command exiting, or within `idleTimeoutMs` when that is longer.
- Only the session that owns the sandbox keeps it running. A subagent that shares its parent's
  sandbox doesn't.
- With `idleTimeoutMs: false`, eve never stops the sandbox, and the option has no effect.
- The default of 30 minutes is what a background command got before the idle stop, when Vercel's
  `timeout` ended it. A longer default would let one forgotten dev server hold a sandbox for that
  long, so longer jobs opt in.
- The option is validated like `idleTimeoutMs`: a non-negative finite number, or the environment
  constructor throws. `SandboxIdleTimeoutOption` carries it, so every built-in constructor accepts
  it, and `DefaultSandbox` takes it at its top level.

On Vercel, `timeout` keeps its name and default, and changes what it counts from:

- eve extends the timeout back to its full length whenever it runs a command or reads, writes, or
  removes a file. `timeout` therefore counts from eve's last use of the sandbox, not from the
  resume.
- When `bash` leaves a command running, eve extends the timeout to cover `backgroundTimeoutMs`.
- Vercel's limit on one session, 45 minutes on Hobby and 24 hours on Pro and Enterprise, still
  applies. At the limit the sandbox stops and the next use resumes it.

```text
               turn                 idle, command running        command exits
session   ├──────────────────┤ · · · · · · · · · · · · · · · · · · · · · ·
sandbox      ├── running ────────────────────────────────────────┤ stopped
             first use   bash returns `running`            next check
timeout      extended on each use ──┤ extended to cover backgroundTimeoutMs
```

## Provider contract

Two optional members, both additive:

```ts
// eve/sandbox/provider
interface SandboxConnection {
  /** Keeps compute running for at least `durationMs` from now, on a backend with its own timer. */
  keepAlive?(options: { readonly durationMs: number }): Promise<void>;
}

interface SandboxSessionIdleOptions {
  readonly signal?: AbortSignal;
  /**
   * Resolves `true` while a command that `bash` left running is still in progress. Call it with a
   * connection to the running sandbox, and leave compute running when it resolves `true`.
   */
  readonly inUse?: (connection: SandboxConnection<object>) => Promise<boolean>;
}
```

- `inUse` goes through `onSessionIdle()` because that method already finds the sandbox without
  starting it. The provider decides whether compute is running, and eve decides whether it is in
  use, with a command it runs over the connection the provider hands it.
- eve sets `inUse` only when a background command may be running and its time isn't up. A provider
  that never calls it stops the sandbox as before, so custom providers change only when they adopt
  it.
- `keepAlive()` is for a backend that stops compute on a timer. eve calls it once, when `bash`
  returns `running`, with `backgroundTimeoutMs`. A failure is logged and the command still returns.

| Provider         | `keepAlive()`                                   | `inUse` in `onSessionIdle()`                                                              |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Vercel           | Extends the running session's timeout.          | Asked only when the session is running, over a connection whose commands never resume it. |
| Docker           | Not implemented. Docker has no timer.           | Asked only when the container is running.                                                 |
| just-bash        | Not implemented. It has no background commands. | Not implemented.                                                                          |
| `DefaultSandbox` | The selected provider's connection.             | Delegates to the provider it selected.                                                    |

## How it runs

- **The marker.** The record that the sandbox may be running gains the time until which a
  background command keeps it running. The step that ran `bash` writes it. While it is absent, the
  idle stop runs exactly as before, with no added command or provider call.
- **The check.** The idle stop step passes `inUse` to the provider. eve's check looks for a `bash`
  job that was reported as running, has no exit code, and whose process group is alive. When it
  finds one, the step leaves the marker set.
- **The wait.** The session's workflow then waits and runs the step again, at intervals that double
  from 1 second up to 5 minutes, and never shorter than `idleTimeoutMs`. A new turn ends the wait.
  A 6-hour command with the default window adds 72 steps.
- **The timeout on Vercel.** The binding reads the session's deadline before each sandbox
  operation and extends it when it is a minute or more short of `timeout`, so an active sandbox
  costs at most one extension request a minute. Each request is abandoned after 10 seconds, and a
  failure never fails the operation. Vercel's API reference says an extension can't pass the plan's
  limit, without saying how it answers one that would. The binding treats a 400, 402, 403, or 422
  as that rejection, asks for half as long until one fits, and logs when none does.
- **A failed check.** A check that fails while a background command may be running leaves the
  marker set, and eve checks again on the same schedule until the command's time is up. Without a
  background command, a failed stop clears the marker and isn't retried, as before.
- **Accepted limits.** eve doesn't stop a sandbox during a turn, so a turn that stays open after
  its background command exits holds the sandbox until Vercel's extended timeout. Vercel can stop a
  session between eve finding it running and running the check; the check then fails, and the next
  one finds the sandbox stopped.
- The harness doesn't change.

## Rollout

- **Vercel, during a turn.** A sandbox stopped 30 minutes after a resume, whatever the turn was
  doing. It now runs while eve uses it, up to the plan's limit.
- **Background commands.** A command that `bash` left running ended 5 minutes after the session
  went idle. It now runs until it exits, for up to 30 minutes, or for `backgroundTimeoutMs`.
- **Cost.** A session with no background command stops as before. A session with one runs until
  the command exits or its time is up, then stops within 5 minutes. With `idleTimeoutMs: false`, a
  Vercel sandbox stops `timeout` after eve last used it, which is later than `timeout` after the
  resume.
- **Existing sandboxes** need no migration. eve reads the timeout that each Vercel sandbox was
  created with.
- **Custom providers** don't change until they call `inUse` or define `keepAlive()`.
- **Release.** `minor`: one new option and two new optional provider members.

## Deferred

- **Detached processes.** A job started with `&` or `nohup` returns as finished, so it doesn't
  keep the sandbox running. Counting every process a command leaves behind would let a daemon hold
  the sandbox, so the `bash` description instead tells the model to run a long job in the
  foreground of its own call.
- **Telling the model more.** The model learns that a command ended only when it checks. Saying in
  the `bash` result how long the sandbox keeps running, and reporting a restart on the next
  command, changes more model-facing text and needs its own evaluation.
- **Subagents that share a sandbox.** A command that a subagent leaves running in its parent's
  sandbox doesn't keep it running, because only the owning session records the marker.
- **A changed `timeout`.** A Vercel sandbox keeps the `timeout` it was created with, so a new value
  in the environment reaches only new sandboxes.
