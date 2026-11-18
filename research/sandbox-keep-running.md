---
issue: https://github.com/vercel/eve/issues/6553
status: implemented
last_updated: "2026-11-18"
---

# Keeping a sandbox running

> **AI status:** Written entirely by AI; human review pending.

## Summary

[Sandbox idle timeout](./sandbox-idle-timeout.md) made eve stop a sandbox once its session goes
idle. Two cases still end a process that someone is waiting for:

| Case                                                       | What ends the process                        |
| ---------------------------------------------------------- | -------------------------------------------- |
| A turn uses a Vercel Sandbox for more than 30 minutes.     | Vercel's `timeout`, 30 minutes after resume. |
| A long job runs in the sandbox, and the session goes idle. | The idle stop, 5 minutes later by default.   |

The first was reported from a production agent that trains models in its sandbox: the sandbox
"restarts about every 30 minutes", which ends the training run. The person using it asked to raise
the sandbox's runtime the way they already raise its vCPUs, through an approved tool. Vercel allows
a session to run for 24 hours on Pro and Enterprise
([limits](https://vercel.com/docs/sandbox/pricing)); the 30 minutes was eve's fixed default, which
eve never extended.

With this change a sandbox's lifetime follows its use, and a tool can keep it running.

## Authoring API

A tool calls `sandbox.keepRunning()` on the session's sandbox:

```ts
interface SandboxKeepRunningOptions {
  readonly forMs: number; // greater than 0, at most 24 hours
  readonly while?: string; // a shell command; the sandbox is kept while it exits 0
}

interface SandboxKeepRunningResult {
  readonly until: Date | null;
}

// on RuntimeSandboxSession, beside stop() and delete()
keepRunning(options: SandboxKeepRunningOptions): Promise<SandboxKeepRunningResult>;
```

The reporting agent's tool, which is also the docs example:

```ts title="agent/tools/keep_sandbox_running.ts"
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description:
    "Keep the sandbox running for a long training run, when the person asks. The run must keep writing to /workspace/train.log.",
  inputSchema: z.object({ hours: z.number().positive().max(12) }),
  approval: always(),
  async execute({ hours }, ctx) {
    const sandbox = await ctx.getSandbox();
    const { until } = await sandbox.keepRunning({
      forMs: hours * 60 * 60 * 1000,
      while: "find /workspace/train.log -mmin -10 | grep -q .",
    });
    return until === null
      ? { kept: false, reason: "eve doesn't stop this sandbox when the session goes idle." }
      : { kept: true, until: until.toISOString() };
  },
});
```

The check tests the job's log, not a process id. A provider can restart a sandbox on its own; a
later turn resumes it from its files, and the job is gone. A process-id check can then pass for
another process for the rest of `forMs`, while a stale log fails within 10 minutes. The command is
a constant, so nothing from the model reaches the shell, and an author who adapts it wrongly gets a
sandbox that stops early, which shows at once. The cost: the sandbox stops up to 15 minutes after
the job ends, and a job silent for 10 minutes loses it.

- Calls combine by `while` text: the same command again moves its time later, never earlier, and
  up to 8 different commands can be in effect. A call without `while` stores `true`.
- `sandbox.stop()`, `sandbox.delete()`, and the session's end clear every call. A new turn doesn't.
- The method throws only for invalid input (with a message naming the limit) or a ninth command.
  Validation runs first, so a wrong call fails on every provider.

| `until` is `null` when                            | Because                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The provider has no `attach()`, such as just-bash | eve can't stop or check its sandbox.                                                                      |
| `idleTimeoutMs: false`                            | eve never stops the sandbox.                                                                              |
| A subagent shares its parent's sandbox            | Only the owning session records the call.                                                                 |
| An `invokeTool` call                              | eve never idle-stops a keyed call's sandbox, and deletes an unkeyed call's sandbox when the call returns. |
| The sandbox was stopped earlier in the same step  | There is nothing running to keep.                                                                         |

`bash` calls `keepRunning()` for every command it returns as `running`, with a fixed 30 minutes and
a check that the command it reported is still alive. A process detached with `&` or `nohup`
returns as finished, so it keeps nothing running unless a tool's `while` names it. There is no
environment option: a tool passes its own `forMs`, and adding an option later is additive.

On Vercel, `timeout` keeps its name and default, and counts from eve's last use of the sandbox:
eve extends it back to its full length whenever it runs a command or reads, writes, or removes a
file. Vercel's limit on one session, 45 minutes on Hobby and 24 hours on Pro and Enterprise, still
applies.

```text
               turn             idle, kept running              check fails
session   ├──────────────┤ · · · · · · · · · · · · · · · · · · · · · · · · ·
sandbox      ├── running ────────────────────────────────────────┤ stopped
             first use   keepRunning()   checks every 5 minutes
timeout      extended on each use, and by each check
```

## Provider contract

```ts
// eve/sandbox/provider
interface SandboxConnection {
  stop(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

interface SandboxProviderImplementation<OpenOptions, Artifact, State, Extensions> {
  attach?(
    ctx: SandboxSessionContext,
    state: Readonly<State> | null,
    options: SandboxAttachOptions, // { signal }
  ): Promise<Pick<SandboxConnection, "close" | "spawn" | "stop" | "workspaceRoot"> | null>;
}
```

- `attach()` connects only to compute that is already running, and resolves `null` otherwise. It
  never starts or resumes the sandbox, and neither may what it returns. eve does the check and the
  stop over that connection, then closes it.
- `stop({ signal })` is additive: eve passes the signal only to a connection that `attach()`
  returned.
- A backend with its own timer counts every connection operation as use; eve never extends it.
  While a sandbox is kept, eve runs a command on it about every 5 minutes, so the timer needs at
  least 15 minutes.

| Provider         | `attach()`                                                                                                                | The `stop({ signal })` it returns                            | Timer renewal                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| Vercel           | Looks the sandbox up without resuming; a connection only for a running or pending session, whose commands never resume it | Stops the sandbox; ignores only a missing one                | Before each operation, extended back to `timeout` |
| Docker           | A connection only for a running container                                                                                 | `docker stop -t 0`; succeeds only when the container is gone | None; Docker has no timer                         |
| just-bash        | Not implemented: no compute and no background processes                                                                   | —                                                            | None                                              |
| `DefaultSandbox` | Delegates to the provider it selected                                                                                     | The selected provider's                                      | The selected provider's                           |

## How it runs

- **The record.** The durable "sandbox may be running" marker carries a list of `{ until, while }`
  records. The step that called `keepRunning()` saves it. Without a record, the session behaves as
  under the idle stop alone, with no added step.
- **The check.** A step attaches to the running sandbox and runs each live record's `while` in the
  workspace root, 10 seconds each. Exit 0 keeps the record; a non-zero exit drops it; a command
  that can't run or doesn't finish counts as passing. When no record remains and the idle window
  has ended, the same step stops the sandbox.
- **The wait.** The session's workflow runs the check at two waits. Between turns, it runs about
  every 5 minutes, the first no later than the end of the idle window. Inside a turn that waits on
  a person, a call, or a task, it runs on the same cadence and never stops the sandbox; a check
  there gives up after 30 seconds, so it delays an answer, a cancel, or a call's timeout by at most
  that much. One more check runs when the last record's time is up. For one call this is at most
  `ceil(forMs / 5 minutes) + 2` steps: 8 for `bash`'s 30 minutes, 290 for 24 hours.
- **The failure rule.** A failed check or a failed stop leaves the durable state as it was, so eve
  tries again at the next check while a record's time isn't up. With no record in effect, a failed
  stop clears the marker and isn't retried before the next turn, and the provider's own timeout is
  the backstop.
- **The Vercel timeout.** The binding reads the session's deadline before each operation and
  extends it when it is a minute or more short of `timeout`. Requests are serialized, each is
  abandoned after 10 seconds, and a failure is logged once and never fails the operation or repeats
  on that connection.

## Rollout

- **Vercel, during a turn.** A sandbox stopped 30 minutes after a resume, whatever the turn was
  doing. It now runs while eve uses it, up to the plan's limit.
- **`bash` commands.** A command that `bash` left running ended with the idle stop. It now keeps
  the sandbox while it runs, for up to 30 minutes.
- **Cost.** A session with no call stops as before. A kept sandbox runs until its check fails or
  its time is up, then stops within 5 minutes; a single call is bounded at 24 hours. If eve can't
  stop it, Vercel stops it `timeout` after eve's last use. With `idleTimeoutMs: false`, a Vercel
  sandbox stops `timeout` after eve last used it, which is later than `timeout` after the resume.
- **Existing sandboxes** need no migration. A marker without records reads as no call.
- **Custom providers** opt in by implementing `attach()`; one with its own timer should restart it
  on every operation. `keepRunning` becomes a reserved session member.
- **Release.** `minor`.

## Deferred

- **An environment option** for a default or a ceiling. A tool passes and caps its own `forMs`; an
  option can be added later without breaking anyone.
- **Counting detached processes.** A daemon, such as a dev server, would hold the sandbox for hours
  by accident. A tool names the job in `while` instead.
- **A subagent keeping its parent's sandbox running.** No durable path from a child to its owner's
  marker exists. Run the long job from the owning agent.
- **Telling the model more.** How long the sandbox is kept, or that it restarted, is new
  model-facing text that needs its own evaluation. The tool returns `until`.
- **A cancel method.** `sandbox.stop()` and a failing `while` already end a call.
- **Telling a restarted sandbox from the one a record was made for.** That needs per-provider or
  operating-system knowledge in the core; a check on what the job keeps doing covers it.
- **Renewing a timer during a turn that runs steps without touching the sandbox.** The workflow
  has no timer beside running steps. Raise `timeout`.
- **eve-driven renewal on use.** Each provider renews its own timer in its connection.
- **Retrying a failed stop with nothing kept**, and **keyed tool sessions**, are unchanged.
- **A changed `timeout`.** A Vercel sandbox keeps the `timeout` it was created with.
