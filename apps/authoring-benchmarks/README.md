# eve authoring evals

This private workspace measures how coding agents author and modify eve projects. It uses
[`@vercel/agent-eval`](https://github.com/vercel-labs/agent-eval) for coding-agent execution,
Vercel Sandbox or local Docker isolation, hidden Vitest graders, transcripts, repeated runs,
model matrices, and result reporting.

These evals are separate from `e2e/`. Runtime e2e suites exercise an already-authored agent
over HTTP; authoring evals give a coding agent a disposable project and grade the resulting
files, commands, validation, and any synthetic world events.

## Cases and treatments

Each directory under `evals/` contains:

- `case.ts`, which selects a reusable starting point, adds optional setup, and defines the user interaction.
- `EVAL.ts`, which contains hidden deterministic assertions.
- Case-specific support files, when needed, which are installed during setup and kept out of sight from the coding agent.
- `PROMPT.md`, a compatibility stub used only by agent-eval to discover the fixture. Its contents are never sent to the coding agent.

A case starts from a shared primitive such as `simpleProject` (the selected revision's real
`eve init` output) or `emptyProject` (an empty directory with the subject CLI installed). This
lets cases reuse an exact starting point rather than maintain an approximation of generated
source, package policy, or coding-agent instructions.

Experiment files under `experiments/` define treatments independently from cases. The
initial pair compares a baseline that removes the scaffolded coding-agent guidance with the
unaltered `eve init` project, including its version-matched `AGENTS.md` and `CLAUDE.md`.

The HarnessAgent adapter owns only the shared authoring lifecycle: bootstrap the selected eve
revision, create an isolated session, capture commands and transcripts, and grade the result.
Each case's `interact` function owns every user turn, including the first, through a small
`send(prompt)` helper. One-turn cases call it once; multi-turn cases keep the conversation in
one place. Reusable setup objects can add bootstrap work, per-session work, ports, environment,
or instructions on top of the selected starting point.

The initial iMessage case keeps real eve registry discovery, `eve add`, the registry setup
protocol, package installation, and project validation. Only the external provider is
synthetic. Its reusable setup package implements a deterministic user input → project creation
→ phone registration decision tree and records events under
`__authoring_eval__/world-events.jsonl`. The iMessage setup owns this synthetic registry and
provider; the shared adapter has no Photon or iMessage knowledge.

The iMessage interaction omits the phone number from its first `send`, inspects the completed
assistant turn, requires the agent to ask for the number, and replies in the same native session.
The hidden grader verifies both the transcript and the structured non-interactive setup protocol.

HarnessAgent's `bootstrapHash` and `onBootstrap` hooks build one reusable Vercel Sandbox snapshot
for each subject repository, revision, starting point, and setup combination. Each benchmark
attempt starts from an independent sandbox restored from that prepared project, then applies
per-session setup and treatment-specific changes.

## Subject revision

By default, the runner evaluates the current checkout's exact `HEAD` from its `origin` remote.
Push the commit first so the sandbox can fetch it. Set both variables below to evaluate a
reachable branch or SHA from another repository:

```sh
EVE_BENCHMARK_REPOSITORY=https://github.com/<owner>/eve.git \
EVE_BENCHMARK_REVISION=<branch-or-SHA> \
  pnpm benchmark:authoring author-000-imessage
```

Remote revisions are resolved to a commit SHA before the experiments start. HarnessAgent then
builds that exact checkout once in the case's reusable sandbox snapshot, without relying on
a published package or mutable branch reference.

## Run

```sh
pnpm benchmark:authoring author-000-imessage
pnpm benchmark:authoring --all
pnpm benchmark:authoring --dry
pnpm benchmark:authoring author-000-imessage --force
```

These benchmarks do not run in CI or as part of `pnpm test`; they run only when invoked with
`pnpm benchmark:authoring`. Passing a case name runs that case, while no name or `--all` runs
every case. Each invocation runs both the `baseline` and `agents-md` treatments.

Agent-eval writes ignored local results under
`apps/authoring-benchmarks/results/<treatment>/<timestamp>/<case>/`. Each case directory contains
`summary.json` and per-run result, transcript, grader output, and copied project files. Use
agent-eval's playground command to inspect or compare results.

`@vercel/agent-eval` chooses Vercel Sandbox when credentials are available and can otherwise
use local Docker. The configured coding agent uses Vercel AI Gateway, so an applicable Gateway
credential is required.

## Adding a case

Copy an existing fixture, give it the next `author-NNN-*` name, then edit `case.ts` and the
hidden grader. Select `simpleProject` or `emptyProject`, compose reusable setup when needed, and
put the complete user interaction in `interact`. There is no scenario registry to update.

Keep setup that is useful across cases under `lib/setups/`. Keep one-off setup next to the case
or inline in `case.ts`. A one-turn filesystem task can be as small as:

```ts
export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send("Add a weather tool to this agent.");
  },
});
```

Prefer final source and deterministic event assertions over an LLM judge. Add a synthetic
command or API world only when the task genuinely needs external state, and keep that world in
the case or a reusable setup rather than the shared HarnessAgent adapter.
