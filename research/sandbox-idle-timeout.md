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
- On a provider that implements `onSessionIdle()`, the value is a non-negative finite number or
  `false`. Anything else throws from the environment constructor.
- A provider's `environment()` receives the option with its own options, unlike `prepare`, so a
  custom provider that already has an option by this name keeps getting it. On a provider without
  `onSessionIdle()`, eve does nothing with it.
- The Vercel provider removes the option before it builds its create options, so it reaches neither
  the template key nor `Sandbox.create`.
- The public type is `SandboxIdleTimeoutOption` from `eve/sandbox/provider`. `WithPrepareOption`
  includes it, and `DockerSandboxEnvironmentOptions` and `DefaultSandboxEnvironmentOptions` extend it.
  `DefaultSandbox` throws when a nested option sets it.

## Provider contract

```ts
// eve/sandbox/provider
interface SandboxProviderImplementation {
  /**
   * Stops compute for `ctx.session.id` if it is running, and keeps its files. Never starts or
   * resumes it. `state` is `null` when the session never recorded it. Must succeed when the
   * sandbox is already stopped or doesn't exist.
   */
  onSessionIdle?(ctx: SandboxSessionContext, state: Readonly<State> | null): Promise<void>;
}
```

- The contract needs a new method because the only stop today is `connection.stop()`, and a
  connection comes from `start()` or `resume()`, which start or resume the sandbox.
- It has the shape of `onSessionEnd()`: no connection, and it finds the sandbox from the session id
  when `state` is `null`, as when only a subagent opened a shared sandbox.
- It is optional. eve doesn't stop a provider without it, so a custom provider behaves as it does
  today until it adds the method.
- eve never calls it for a keyed `invokeTool` sandbox, where `ctx.kind` is `"tool-session"`.

| Provider         | `onSessionIdle()`                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vercel           | Looks the sandbox up by name without resuming it, and stops it if it is running.                                                                       |
| Docker           | Runs `docker stop` on the session's container.                                                                                                         |
| just-bash        | Not implemented. It has no compute to stop.                                                                                                            |
| `DefaultSandbox` | Delegates to the provider it selected. When `state` is `null` it finds that provider from the prepared artifact, through the channel session end uses. |

## How it runs

- **What eve records.** The recorded sandbox state of the session that owns the sandbox gains a
  marker that the sandbox may be running, with the window that applies:
  `running: { generation, idleTimeoutMs }` beside `session` in `SandboxState`. `generation` names one
  running period: it is kept while the marker is carried and replaced when the sandbox starts
  running again after a stop. A session recorded without the marker reads as clear, so no migration
  or checkpoint version change is needed. eve sets the marker only when the option isn't `false`
  and the provider implements `onSessionIdle()`. `DefaultSandbox` also skips it when its recorded
  state names a provider without `onSessionIdle()`, such as just-bash; with no recorded state it
  marks, since it can't tell. The marker is set at these points:
  - A step of the session opens the sandbox, or tries to.
  - A turn step is cancelled or recovered, because eve can't tell whether it opened the sandbox.
  - The session starts a workflow tool run. eve starts every subagent from a workflow tool run, so
    this covers a subagent that shares the sandbox. It also covers one with its own sandbox, which
    costs one stop that finds nothing running.
  - The session's prewarm step opens the sandbox. The step returns the marker beside its state, and
    the loop holds it in memory when the step's result is dropped because the first message arrived
    first. Until the prewarm settles, the session isn't idle.
- **Carrying it.** Every later step of the session keeps the marker and refreshes the window from
  its own deployment. A step that fails outright records nothing, and the provider's own timeout
  bounds that case.
- **No overhead otherwise.** While the marker is clear, eve adds no timer, step, or provider call.
- **The wait.** Just before the session would wait on its inbox for the next message, if the
  marker is set and the session is idle, its own workflow sleeps until the window ends, raced
  against its inbox, the way a turn already waits on a task timeout. A pending prewarm or handover
  is raced the same way, so the session checks again once it settles. The window belongs to the
  marker's `generation`, so a sandbox that a between-turn hook stops and a later one reopens starts
  a new window. It doesn't use the `limits.sessionTimeoutMs` timer, whose signal ends the session
  and which `sessionTimeoutMs: false` turns off.
- **The stop.** When the sleep wins, no message is waiting, and the session is still idle, one
  step, `stopIdleSessionSandboxStep`, calls `onSessionIdle()` and clears the marker, whether or not
  the call succeeds. The call is bounded at 120 seconds: a Vercel stop returns once its snapshot is
  written, and 120 seconds matches the ceiling eve already uses for `bash`, which keeps a hosted
  step inside Vercel's 300-second Hobby function limit. A call that hasn't finished by then is
  abandoned and logged, so a hung provider can't hold the session's messages. Once the provider call
  succeeds, the step also stops tracking the sandbox for server shutdown, as session end does; after
  a failed or abandoned call, server shutdown still stops it. eve doesn't retry: a failure is logged
  and the provider's own timeout remains the backstop. If the step itself rejects, the session
  continues, and eve makes no further attempt until the next turn. The session loop awaits the step,
  so a message that arrives during it waits and the session's next turn can't overlap the stop.
  With `0` there is no sleep.
- **Cost.** One sleep and one step per idle period, and no extra workflow run. A sleep that loses
  the race to a message still wakes the run once when it elapses.
- **Deployment handoff.** A window isn't carried to the session's next run. That run starts a new
  window from the recorded marker.
- **Late use.** A step still winding down after its task was cancelled can use the sandbox after
  the stop and restart it. eve doesn't stop a sandbox restarted that late, as at session end, and
  the provider's own timeout bounds it.
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
- **Docs.** `docs/sandbox/index.mdx` gains a "Stop an idle sandbox" section and the idle row in its
  lifecycle table. The Vercel and Docker pages state their own timeout and this one, and the
  `DefaultSandbox` options table lists the top-level option. `docs/sandbox/custom-providers.mdx`
  covers `onSessionIdle()` in place of its advice to limit idle compute yourself. The `turn.settled`
  stop recipe leaves `docs/guides/hooks.md`. The prewarming section of `useEveAgent` and the
  workflow-step sandbox notes mention the idle stop.
- **Coverage.** An e2e eval in `e2e/fixtures/agent-tools-sandbox`, `evals/sandbox/idle-stop.eval.ts`,
  uses a subagent, `idle-stop`, with its own environment set to `idleTimeoutMs: 0`. It continues the
  same child by `taskId` and checks on its next turn that a background process is gone and a file
  it wrote remains. The fixture's shared environment keeps the default, because its
  definition starts a server that other evals use.

## Deferred

- **Compute during a turn.** eve doesn't stop a sandbox while a turn is open, so a long turn, or one
  waiting on a person, holds it until the provider's timeout. On Vercel that timeout also ends a
  session that is still busy at minute 30. Sizing it by actual use is a separate change.
- **Snapshot retention.** eve sets no retention on session sandboxes, so snapshots are kept until
  they expire. Keyed `invokeTool` sandboxes already keep only the latest.
