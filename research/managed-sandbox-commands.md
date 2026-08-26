---
issue: https://github.com/vercel/eve/issues/440
status: proposed
last_updated: "2026-08-26"
---

# Managed sandbox commands

## Summary

Long-running shell commands need to return control to the model without tying
their lifecycle to one durable workflow step. `SandboxSession.spawn()` exposes
a live process handle, but that handle is local to the app runtime that opened
it; generic shell wrappers and PID files duplicate process management inside
the sandbox and are brittle across shells and providers.

Add an internal eve-owned managed-command capability at the sandbox execution
boundary. The built-in `bash` tool starts, inspects, waits for, and terminates
commands through this capability while keeping provider handles out of the
public tool API.

## Tool API

```json
{ "action": "run", "command": "pnpm test", "yieldTimeMs": 300000 }
{ "action": "poll", "processId": "..." }
{ "action": "wait", "processId": "...", "yieldTimeMs": 30000 }
{ "action": "kill", "processId": "..." }
```

A run that completes during the foreground wait returns its exit code. A run
that remains active returns an opaque process id. Follow-up actions never
resubmit the command represented by that id.

## Internal boundary

```ts
interface ManagedSandboxCommands {
  start(input: { command: string; idempotencyKey: string }): Promise<ManagedSandboxCommand>;
  get(commandId: string): Promise<ManagedSandboxCommand>;
}

interface ManagedSandboxCommand {
  commandId: string;
  inspect(): Promise<CommandObservation>;
  inspectStatus(): Promise<{ exitCode?: number }>;
  terminate(): Promise<void>;
}
```

The generic implementation adapts `SandboxSession.spawn()` and retains bounded
output and process handles in the app runtime. Vercel registers a provider
implementation that uses detached command ids and `getCommand()` to reconnect
a process after app-runtime relocation. A backend that cannot recover a lost
handle reports the command as unavailable.

## Semantics

- The Bash tool call id is the start idempotency key within a live command
  registry, so a retried submission in that runtime returns the same command.
- Output remains tail-truncated within eve's shared line and byte budgets.
- A runtime tracks at most 64 commands per sandbox and reclaims completed
  entries before rejecting a new start.
- Cancellation terminates the managed command. Observation failures do not.
- Backend shutdown or expiration may make a process id unavailable. Follow-up
  actions report that state and do not replay the command.
- Managed command ids are scoped to the sandbox session. Agents that explicitly
  share a sandbox address the same provider command namespace.

## Scope

This does not expose process management on the public `SandboxSession` API,
list arbitrary operating-system processes, guarantee command recovery for
backends without provider command lookup, or recover an interrupted initial
submission whose command id was never observed. Stream recovery remains a
separate concern.
