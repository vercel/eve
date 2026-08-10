# eve authoring benchmarks

This private app measures how coding harnesses configure an eve project. It is
separate from `e2e/`: those evals exercise an already-authored agent over HTTP,
while these benchmarks give a coding agent a disposable workspace and grade its
commands, external-system interactions, resulting source, and final handoff.

## Photon starting point

The first case asks:

> Let me talk to this agent via iMessage.

It runs Pi through AI SDK `HarnessAgent` in Vercel Sandbox. The case has three
independent pieces:

- `cases/photon-imessage.ts` owns the prompt and deterministic graders.
- `user-simulator.ts` supplies one phone number and fails any other request for
  user input.
- `world/photon-world.ts` simulates Photon, Vercel CLI, and browser effects at
  their process/network boundaries. eve itself has no benchmark-specific
  provider flags.

The current world uses one inherited Node preload to route Photon `fetch` calls
to a sandbox-local stateful server. Vercel and browser calls use executables
placed first in `PATH`. These are transport details behind `BenchmarkWorld` and
can move to network-policy forwarding without changing cases or graders.

## Run

The benchmark requires Vercel Sandbox credentials and a model credential usable
by the Pi harness.

```sh
pnpm --filter @eve-internal/authoring-benchmarks benchmark:photon
pnpm --filter @eve-internal/authoring-benchmarks benchmark:photon -- --model <pi-model-id>
pnpm benchmark:authoring photon-imessage --verbose
pnpm benchmark:authoring photon-imessage --summarize
pnpm benchmark:authoring photon-imessage --summarize --summary-model openai/gpt-5.4-mini
```

By default the sandbox fetches the current `origin/main` from `vercel/eve` for
every run; it does not use the invoking checkout's potentially stale local
`main`. Override either value for a branch or fork reachable from the sandbox:

```sh
EVE_BENCHMARK_REPOSITORY=https://github.com/<owner>/eve.git \
EVE_BENCHMARK_REVISION=<branch> \
  pnpm --filter @eve-internal/authoring-benchmarks benchmark:photon
```

The first run for a case/revision builds a reusable Vercel Sandbox template:
it clones, installs, and builds eve, creates the fresh project, and installs its
dependencies before snapshotting. The runner resolves branch names such as
`origin/main` to a commit SHA before constructing the cache identity, so repeated
commands reuse the same template until that branch actually advances. Later
runs fork that snapshot and perform only run-scoped setup. Changing the subject
commit or benchmark bootstrap version intentionally creates a new template.
Each concurrent eval still gets an isolated sandbox fork and workspace; they
share the immutable prepared snapshot, not mutable run state.

The CLI prints each setup phase and a heartbeat every 15 seconds while sandbox
or model work is in flight. Pass `--verbose` to also stream normalized
HarnessAgent diagnostics. Pass `--summarize` to have a separate inexpensive LLM
read the transcript, tool activity, world events, checks, and run error and print
a concise operator summary. It defaults to `openai/gpt-5.4-mini`; override it
with `--summary-model`. The summary is also persisted in the run artifact.

Run artifacts are written to `.eve/authoring-benchmarks/`, relative to the
repository root when invoked through the commands above. The CLI prints the
absolute artifact path when a run finishes. Each JSON artifact contains the
transcript, normalized tool calls, HarnessAgent diagnostics, setup-world events,
usage, checks, and any caught error.

If startup fails before the artifact can be assembled, the CLI prints the
sandbox process's stdout/stderr directly. The Photon world also records its
successful interactions in the artifact's `worldEvents`; there is intentionally
no separate persistent sandbox log to hunt down.

## Known first-iteration constraints

- The Vercel shim covers the Photon happy-path commands only. Unhandled commands
  fail rather than silently succeeding.
- The user simulator recognizes direct phone-number questions using a narrow
  deterministic matcher. A cheap model-backed classifier can replace it later
  without changing the case contract.
