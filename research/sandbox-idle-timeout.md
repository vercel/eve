---
issue: https://github.com/vercel/eve/issues/6553
status: implemented
last_updated: "2026-11-17"
---

# Sandbox idle timeout

> **AI status:** Written entirely by AI; human review pending.

## Summary

eve starts a session's sandbox compute on first use and never releases it. Only `sandbox.stop()`,
`sandbox.delete()`, the end of the session, and server shutdown do. Until then each provider
decides how long the compute runs:

| Provider | Compute runs                                          |
| -------- | ----------------------------------------------------- |
| Vercel   | Until a fixed deadline, 30 minutes after each resume. |
| Docker   | Until the eve server stops (#1134).                   |
| Custom   | Until the provider's own limit, if it has one.        |

Vercel bills a running sandbox's memory for wall-clock time, so a turn that runs one short command
pays for 30 minutes: about $0.042 at the default 2 vCPUs and 4 GB, against $0.007 for 5 minutes, at
`iad1` list rates ([pricing](https://vercel.com/docs/sandbox/pricing)). Before #6187, once a session
had a sandbox, every turn resumed it and paid that.

The documented way to stop sooner is a `turn.settled` hook that calls `ctx.getSandbox()` and then
`stop()`. `ctx.getSandbox()` opens the sandbox, so on a turn that never used it the hook resumes or
creates the sandbox in order to stop it.

This plan has eve stop a session's sandbox once the session has been idle for a window, 5 minutes by
default.

## Authoring API

`idleTimeoutMs` is an option of every sandbox environment, like `prepare`:

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const environment = VercelSandbox.environment({
  // optional: how long the sandbox keeps running after the session goes idle
  idleTimeoutMs: 0,
});

export default defineSandbox(() => environment.open());
```

| Value   | Result                                                            |
| ------- | ----------------------------------------------------------------- |
| Omitted | The sandbox stops 5 minutes after the session goes idle.          |
| `0`     | The sandbox stops when the session goes idle.                     |
| `false` | eve never stops it. The provider's own timeout applies, as today. |

- A session is idle when it has no open turn, no working task, nothing queued or held for a
  handover, and no prewarm still starting. A turn waiting on a person is still open. With `0`, the
  sandbox therefore doesn't stop between queued messages, or before a turn that a hook starts with
  `ctx.continue()`.
- The window starts once the session is idle and its sandbox may be running, whichever comes last.
  A new turn ends the window. Other traffic to the session doesn't restart it.
- When the window ends, eve stops the sandbox's compute. Files persist, processes in the sandbox
  end, and the next use resumes it, as with `sandbox.stop()`.
- eve never starts or resumes a sandbox in order to stop it. A sandbox that isn't running, or was
  never created, is left alone.
- A later turn pays to resume the sandbox only if it uses it, on its first sandbox call. A longer
  window lets a follow-up turn reuse the running sandbox.
- Only the session that owns the sandbox stops it. A subagent that shares its parent's sandbox
  doesn't, and neither does a copy of the agent started by the `agent` tool.
- A prewarmed session's sandbox stops if no message arrives within the window. With `0`, prewarming
  doesn't start the sandbox.
- eve takes the option from the deployment that runs the session's steps, so a deploy that changes
  it applies to an existing session from its next step there.
- The provider's own timeout still applies. On Vercel, `timeout` stays the longest one session runs,
  30 minutes by default, including during a turn.

```text
               turn              idle window              next turn
session   ├─────────────┤ · · · · · · · · · · · ┤      ├─────────────┤
sandbox       ├── running ──────────────────────┤ stopped  ├── running ──
              first use                         stop       first use
```

Where the option goes:

- `DefaultSandbox.environment()`, `VercelSandbox.environment()`, `JustBashSandbox.environment()`,
  `DockerSandbox.environment()`, `DockerSandbox.dockerfile()`, `DockerSandbox.image()`, and every
  provider from `defineSandboxProvider()` accept it.
- On `DefaultSandbox` it is a top-level option. The nested `vercel`, `docker`, and `justBash`
  options don't accept it.
- The value is a non-negative finite number or `false`. Anything else throws from the environment
  constructor, for every provider.
- eve owns the option, as it owns `prepare`: a provider's `environment()` never receives it. On a
  provider without `onSessionIdle()`, eve does nothing with it.
- The public type is `SandboxIdleTimeoutOption` from `eve/sandbox/provider`. `WithPrepareOption`
  includes it, and `DockerSandboxEnvironmentOptions` and `DefaultSandboxEnvironmentOptions` extend it.

## Provider contract

```ts
// eve/sandbox/provider
interface SandboxSessionIdleOptions {
  /** Aborted when eve abandons the call. */
  readonly signal?: AbortSignal;
}

interface SandboxProviderImplementation {
  /**
   * Stops compute for `ctx.session.id` if it is running, and keeps its files. Never starts or
   * resumes it. `state` is `null` when the session never recorded it. Must succeed when the
   * sandbox is already stopped or doesn't exist.
   */
  onSessionIdle?(
    ctx: SandboxSessionContext,
    state: Readonly<State> | null,
    options: SandboxSessionIdleOptions,
  ): Promise<void>;
}
```

- The contract needs a new method because the only stop today is `connection.stop()`, and a
  connection comes from `start()` or `resume()`, which start or resume the sandbox.
- It has the shape of `onSessionEnd()`: no connection, it finds the sandbox from the session id
  when `state` is `null`, as when only a subagent opened a shared sandbox, and its third argument
  carries a `signal`. An implementation can leave that argument out.
- It is optional. eve doesn't stop a provider without it, so a custom provider behaves as it does
  today until it adds the method.
- eve never calls it for a keyed `invokeTool` sandbox, where `ctx.kind` is `"tool-session"`.

| Provider         | `onSessionIdle()`                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Vercel           | Looks the sandbox up by name without resuming it, and stops it if it is running. Both requests take the signal.          |
| Docker           | Runs `docker stop -t 0` on the session's container, and passes the signal to the command.                                |
| just-bash        | Not implemented. It has no compute to stop.                                                                              |
| `DefaultSandbox` | Delegates to the provider it selected, named by its recorded state or, when `state` is `null`, by its prepared artifact. |

## How it runs

- **The marker.** The session that owns the sandbox records, beside its sandbox state, that the
  sandbox may be running and the window that applies. eve sets it whenever it can't rule out a
  running sandbox, and skips it when the option is `false` or the selected provider can't stop
  idle sandboxes, such as just-bash. A session recorded before this change reads as clear. While
  the marker is clear, eve adds no timer, step, or provider call.
- **The wait.** When the session is idle and the marker is set, the session's workflow sleeps for
  the window, raced against its inbox. A turn starts the window again. It isn't the
  `sessionTimeoutMs` timer, which ends the session.
- **The stop.** One awaited step calls `onSessionIdle()`, bounded at 120 seconds, after which eve
  aborts its `signal`. The step clears the marker whatever the outcome. A failure is logged, and eve
  doesn't try again before the next turn; the provider's own timeout remains the backstop.
- **Accepted limits.** A step still running after the stop, such as a cancelled task's, or a sharing
  child's `ctx.continue()` turn, can use the sandbox after the parent stopped it, and resumes it. A
  prewarm marker that isn't recorded yet is lost if the first message both beats the prewarm and
  moves the session to another deployment. The provider's own timeout bounds these cases.
- The harness doesn't change.

## Rollout

- **Vercel.** A sandbox ran until 30 minutes after a resume. It now stops 5 minutes after the
  session goes idle, when that comes first.
- **Processes.** A process left running after a turn ends with the window. That includes one the
  `defineSandbox()` definition started, because a resume doesn't run the definition again. Vercel
  already ends them at 30 minutes. On Docker this is new.
- **Snapshots.** Each idle stop on Vercel writes a snapshot, as each timeout does today. One
  30-minute session used to span several turns, so a session whose turns are 5 to 30 minutes apart
  now writes more of them.
- **Docker.** A container ran until the server stopped. It now stops 5 minutes after the session
  goes idle and restarts on the next use. #1134 hits a limit on running containers, and stopped
  containers don't count toward it.
- **Existing sandboxes** need no migration. A session gets the behavior once it runs on a deployment
  that has it.
- **Custom providers** don't change until they implement `onSessionIdle()`.
- **Release.** `minor`: one new option and one new optional provider method. The changeset leads
  with the new default, names `idleTimeoutMs: false` as the way back, and says a `turn.settled`
  hook that stops the sandbox is no longer needed.

## Deferred

- **Compute during a turn.** eve doesn't stop a sandbox while a turn is open, so a long turn, or one
  waiting on a person, holds it until the provider's timeout. On Vercel that timeout also ends a
  session that is still busy at minute 30. Sizing it by actual use is a separate change.
- **Snapshot retention.** eve sets no retention on session sandboxes, so snapshots are kept until
  they expire. Keyed `invokeTool` sandboxes already keep only the latest.
