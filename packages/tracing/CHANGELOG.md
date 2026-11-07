# @vercel/agent-runs

## 1.0.0-rc.4

Released 2026-11-07 · [Compare with 1.0.0-rc.3](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%401.0.0-rc.3...%40vercel%2Fagent-runs%401.0.0-rc.4)

### Features

- Add `decision <model>` OpenTelemetry spans for `decide`, automatic model selection, and tool approvals, with policy-aware model, usage, cost, and failure metadata that distinguishes refusals from request failures.
  A decision sits under the operation it runs in, or under the turn when model routing runs before the turn's first step. `@vercel/agent-runs` adds `AgentRun.decision` and an optional `AgentTelemetry.activeSpan`, so a decision nests under a host span inside its operation but not under a host span from another trace, such as a workflow step. ([#5349](https://github.com/vercel/eve/pull/5349))

### Bug Fixes

- Make connection sign-ins countable in traces: each sign-in span names its agent, a failed sign-in records its reason, and a call a connection refused records which connection and why.
  `agent.approval` spans now carry `gen_ai.agent.name` and `agent.name`, so a query scoped to one agent no longer drops its sign-in prompts. A sign-in that fails with a reason code such as `access_denied` records it as `agent.connection.authorization.reason`; a sign-in that ends any other way, such as one a new message withdrew, records none. A tool call that fails with `ConnectionAuthorizationFailedError`, including one that never asked anyone to sign in, such as `principal_required` or `sign_in_unavailable` in a turn a schedule started, records `eve.connection.name` and `agent.connection.authorization.reason` on its `execute_tool` span. Only reason codes are recorded: a free-text reason or error message stays off the span whatever the trace policy records. ([#6078](https://github.com/vercel/eve/pull/6078))

## 1.0.0-rc.3

Released 2026-11-05 · [Compare with 1.0.0-rc.2](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%401.0.0-rc.2...%40vercel%2Fagent-runs%401.0.0-rc.3)

### Features

- Record an `agent.approval` span for every wait on a person, including questions, budget prompts, and connection sign-ins, not just tool approvals.
  `agent.approval.kind` is `tool-approval`, `question`, `budget`, or `sign-in`. A wait sits under the tool call it's about, or under the turn when no call owns it, and a sign-in names its connection in `eve.connection.name`. Instrumentation providers now receive sign-ins on `interaction.opened` and `interaction.settled`, with `signIn.name` naming the connection or tool; the sign-in URL and code stay out of the event. Questions and sign-ins from workflow tools such as `ask_question` now reach providers too, reported by the session that owns the tool call; a request a subagent asks is still reported once, by that session. `@vercel/agent-runs` adds `TurnOperation.approval` and `findApproval`, and an optional `kind` and `connectionName` on approvals. ([#6004](https://github.com/vercel/eve/pull/6004))

### Bug Fixes

- Store a turn's attributes once in its checkpoint.
  The turn's copy of the model input and output was also saved in the turn's data, which doubled that content in every checkpoint write and sent large prompts into the oversized-checkpoint fallback. Exported spans are unchanged. ([#5949](https://github.com/vercel/eve/pull/5949))

## 1.0.0-rc.2

Released 2026-11-05 · [Compare with 1.0.0-rc.1](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%401.0.0-rc.1...%40vercel%2Fagent-runs%401.0.0-rc.2)

### Bug Fixes

- Keep oversized checkpoints honest by preserving the real `agent.trace.content.input`/`output` capture flags and keeping the turn's copied input/output as a truncated copy (or omitting it) instead of rewriting the flags to `false` when a turn node exceeds the checkpoint size budget. ([#5945](https://github.com/vercel/eve/pull/5945))
- Raise the tracing content caps from 32 KiB per attribute and 64 KiB per checkpointed operation to 250 KiB and 512 KiB, so prompts up to 250 KiB are captured in full instead of truncated. ([#5945](https://github.com/vercel/eve/pull/5945))

## 1.0.0-rc.1

Released 2026-11-03 · [Compare with 1.0.0-rc.0](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%401.0.0-rc.0...%40vercel%2Fagent-runs%401.0.0-rc.1)

### Bug Fixes

- Fix durable agent traces keeping every finished turn that called tools in parallel: each one stayed in the session's serialized context, so step inputs grew with every turn.
  A checkpoint this process had already written, read back through another execution context, was treated as another process's write and forked the turn's trace tree; the stale copy then overwrote the tool completions and the checkpoint was never deleted. A replaced tree now also stops persisting. ([#5835](https://github.com/vercel/eve/pull/5835))

## 1.0.0-rc.0

Released 2026-10-30 · [Compare with 0.0.4](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%400.0.4...%40vercel%2Fagent-runs%401.0.0-rc.0)

### Breaking Changes

- `@vercel/agent-runs` 1.0 puts its public API under semantic versioning, so it changes incompatibly only in a major release. ([#5620](https://github.com/vercel/eve/pull/5620))

## 0.0.4

Released 2026-10-29 · [Compare with 0.0.3](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%400.0.3...%40vercel%2Fagent-runs%400.0.4)

### Bug Fixes

- Release notes now list breaking changes first and use plain headings, one paragraph per change, and a single compare link.
  A `minor` changeset always appears under Breaking Changes, so breaking changes merged with an internal PR title are no longer left out. The 0.86.0 and 0.87.0 notes now include the two breaking changes they missed. ([#5588](https://github.com/vercel/eve/pull/5588))

## 0.0.3

Released 2026-10-28 · [Compare with 0.0.2](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%400.0.2...%40vercel%2Fagent-runs%400.0.3)

### Bug Fixes

- Resolve catalog dependencies in staged packages so npm can install them. ([#5554](https://github.com/vercel/eve/pull/5554))
- Restore current release notes to `CHANGELOG.md` at the package root. ([#5552](https://github.com/vercel/eve/pull/5552))

## 0.0.2

Released 2026-10-28 · [Compare with 0.0.1](https://github.com/vercel/eve/compare/%40vercel%2Fagent-runs%400.0.1...%40vercel%2Fagent-runs%400.0.2)

### Features

- Ship current release notes at `dist/CHANGELOG.md` with a version-pinned link to the full changelog. ([#5446](https://github.com/vercel/eve/pull/5446))

## 0.0.1

### Patch Changes

- c1b079c: Publish framework-neutral tracing as `@vercel/agent-runs` with singular `createAgentRun` and `AgentRun` APIs; eve still bundles it without a new runtime dependency. Also fix a development-server build failure in npm-installed apps when generating source maps.
